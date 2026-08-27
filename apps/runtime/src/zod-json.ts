import type { ZodTypeAny } from 'zod';

/**
 * 最小 zod v3 → JSON Schema 转换器，覆盖工具入参用到的构造：
 * object/string/number/boolean/array/enum/record/optional/default/describe。
 * 刻意保持精简，避免引入额外依赖；新增构造时在此扩展。
 */
export function zodToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const def = (schema as { _def?: { description?: string } })._def;
  const out = convert(schema);
  if (def?.description && !out.description) out.description = def.description;
  return out;
}

function convert(schema: ZodTypeAny): Record<string, unknown> {
  const def = (schema as { _def: Record<string, unknown> })._def;
  const typeName = def.typeName as string;
  const desc = def.description as string | undefined;
  const withDesc = (o: Record<string, unknown>) => (desc ? { ...o, description: desc } : o);

  switch (typeName) {
    case 'ZodObject': {
      const shape = (def.shape as () => Record<string, ZodTypeAny>)();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, child] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(child);
        if (!isOptional(child)) required.push(key);
      }
      return withDesc({
        type: 'object',
        properties,
        ...(required.length ? { required } : {}),
        additionalProperties: false,
      });
    }
    case 'ZodString': {
      const checks = (def.checks as { kind: string }[]) ?? [];
      const o: Record<string, unknown> = { type: 'string' };
      if (checks.some((c) => c.kind === 'url')) o.format = 'uri';
      return withDesc(o);
    }
    case 'ZodNumber': {
      const checks = (def.checks as { kind: string; value?: number }[]) ?? [];
      const o: Record<string, unknown> = {
        type: checks.some((c) => c.kind === 'int') ? 'integer' : 'number',
      };
      const min = checks.find((c) => c.kind === 'min');
      const max = checks.find((c) => c.kind === 'max');
      if (min?.value !== undefined) o.minimum = min.value;
      if (max?.value !== undefined) o.maximum = max.value;
      return withDesc(o);
    }
    case 'ZodBoolean':
      return withDesc({ type: 'boolean' });
    case 'ZodArray':
      return withDesc({ type: 'array', items: zodToJsonSchema(def.type as ZodTypeAny) });
    case 'ZodEnum':
      return withDesc({ type: 'string', enum: def.values as string[] });
    case 'ZodRecord':
      return withDesc({ type: 'object', additionalProperties: true });
    case 'ZodOptional':
    case 'ZodDefault': {
      const inner = zodToJsonSchema(def.innerType as ZodTypeAny);
      if (desc && !inner.description) inner.description = desc;
      return inner;
    }
    case 'ZodEffects':
      return zodToJsonSchema(def.schema as ZodTypeAny);
    default:
      return withDesc({ type: 'string' });
  }
}

function isOptional(schema: ZodTypeAny): boolean {
  const typeName = (schema as { _def: { typeName: string } })._def.typeName;
  return typeName === 'ZodOptional' || typeName === 'ZodDefault';
}
