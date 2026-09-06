import { beforeEach, describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { DANGER_RULES } from '@apolla/runtime';
import { PolicyService, validatePattern } from './policy.service.js';

/** 策略中心（T-413）：内置只能启停、自定义可增删改、生效集合按组织/空间合并、坏正则进不来 */
class FakePrisma {
  rows: any[] = [];
  private seq = 0;
  policy = {
    findMany: async ({ where }: any) =>
      this.rows.filter((r) => {
        if (r.orgId !== where.orgId) return false;
        if (where.OR) return where.OR.some((c: any) => r.workspaceId === (c.workspaceId ?? null));
        return true;
      }),
    findFirst: async ({ where }: any) =>
      this.rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null,
    create: async ({ data }: any) => {
      const row = { id: `p${++this.seq}`, workspaceId: null, flags: '', builtinKey: null, createdAt: new Date(), updatedAt: new Date(), ...data };
      this.rows.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const r = this.rows.find((x) => x.id === where.id);
      Object.assign(r, data);
      return r;
    },
    delete: async ({ where }: any) => {
      this.rows = this.rows.filter((x) => x.id !== where.id);
    },
  };
}

let db: FakePrisma;
let svc: PolicyService;
beforeEach(() => {
  db = new FakePrisma();
  svc = new PolicyService(db as never);
});

describe('validatePattern', () => {
  it('合法正则通过；空/超长/坏正则/嵌套量词拒绝', () => {
    expect(validatePattern('\\bscp\\b')).toBeInstanceOf(RegExp);
    for (const bad of ['', 'a'.repeat(401), '(unclosed', '(a+)+b']) {
      expect(() => validatePattern(bad)).toThrow(BadRequestException);
    }
    expect(() => validatePattern('x', 'q')).toThrow(BadRequestException);
  });
});

describe('PolicyService', () => {
  it('默认：生效集合 = 全部内置规则', async () => {
    const rules = await svc.effectiveRules('org1');
    expect(rules.map((r) => r.key)).toEqual(DANGER_RULES.map((r) => r.key));
  });

  it('★ 禁用一条内置规则：列表标记 enabled=false，生效集合里消失；再启用即恢复', async () => {
    await svc.setBuiltin('org1', 'git-push', false);
    expect((await svc.list('org1')).find((v) => v.builtinKey === 'git-push')?.enabled).toBe(false);
    expect((await svc.effectiveRules('org1')).some((r) => r.key === 'git-push')).toBe(false);
    await svc.setBuiltin('org1', 'git-push', true);
    expect((await svc.effectiveRules('org1')).some((r) => r.key === 'git-push')).toBe(true);
  });

  it('★ 内置规则不能删、不能改正文', async () => {
    const row = await svc.setBuiltin('org1', 'sudo', false);
    await expect(svc.deleteCustom('org1', row.id)).rejects.toThrow(/不能删除/);
    await expect(svc.updateCustom('org1', row.id, { pattern: 'x' })).rejects.toThrow(/不能修改正文/);
  });

  it('★ 自定义规则：组织级对全部空间生效，空间级只对该空间生效', async () => {
    await svc.createCustom('org1', { kind: 'network_egress', pattern: '\\bscp\\b', reason: '禁止 scp 外传' });
    await svc.createCustom('org1', { kind: 'bash_command', pattern: 'drop\\s+table', flags: 'i', reason: '禁删表', workspaceId: 'ws-fin' });
    const anyWs = await svc.effectiveRules('org1', 'ws-other');
    expect(anyWs.some((r) => r.pattern === '\\bscp\\b')).toBe(true);
    expect(anyWs.some((r) => r.pattern === 'drop\\s+table')).toBe(false);
    const fin = await svc.effectiveRules('org1', 'ws-fin');
    expect(fin.some((r) => r.pattern === 'drop\\s+table' && r.flags === 'i')).toBe(true);
  });

  it('自定义规则可停用、可改、可删；跨组织不可见', async () => {
    const c = await svc.createCustom('org1', { kind: 'bash_command', pattern: 'foo', reason: 'x' });
    await svc.updateCustom('org1', c.id, { enabled: false });
    expect((await svc.effectiveRules('org1')).some((r) => r.pattern === 'foo')).toBe(false);
    await svc.updateCustom('org1', c.id, { pattern: 'bar', enabled: true });
    expect((await svc.effectiveRules('org1')).some((r) => r.pattern === 'bar')).toBe(true);
    await expect(svc.deleteCustom('org2', c.id)).rejects.toThrow(/不存在/);
    await svc.deleteCustom('org1', c.id);
    expect((await svc.list('org1')).filter((v) => !v.builtin)).toHaveLength(0);
  });

  it('坏 kind / 空说明 / 坏正则 拒绝入库', async () => {
    await expect(svc.createCustom('org1', { kind: 'weird', pattern: 'a', reason: 'r' })).rejects.toThrow(/kind/);
    await expect(svc.createCustom('org1', { kind: 'bash_command', pattern: 'a', reason: ' ' })).rejects.toThrow(/说明/);
    await expect(svc.createCustom('org1', { kind: 'bash_command', pattern: '(a+)+', reason: 'r' })).rejects.toThrow(/回溯/);
  });
});
