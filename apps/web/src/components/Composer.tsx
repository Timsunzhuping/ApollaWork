import { useRef, useState } from 'react';
import type { PermissionMode, ModelTier } from '@apolla/protocol';
import { useUI } from '../store';
import { IconSend, IconPlus, IconStop } from '../icons';

const MODE_LABEL: Record<PermissionMode, string> = { auto: '自动执行', plan: '先计划', ask: '谨慎审批' };
const TIER_LABEL: Record<ModelTier, string> = { auto: 'Auto', fast: '快速', deep: '深度' };

interface Props {
  onSubmit: (prompt: string) => void;
  busy?: boolean;
  onStop?: () => void;
  compact?: boolean;
  placeholder?: string;
}

export function Composer({ onSubmit, busy, onStop, compact, placeholder }: Props) {
  const [text, setText] = useState('');
  const { mode, setMode, modelTier, setModelTier } = useUI();
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const t = text.trim();
    if (!t || busy) return;
    onSubmit(t);
    setText('');
    if (ref.current) ref.current.style.height = 'auto';
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  const grow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  return (
    <div className="bg-surface border border-line rounded-2xl shadow-[0_2px_16px_rgba(26,36,32,0.05)] focus-within:border-primary/40 focus-within:shadow-[0_2px_20px_rgba(15,122,92,0.10)] transition-all">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          grow();
        }}
        onKeyDown={onKey}
        rows={compact ? 1 : 2}
        placeholder={placeholder ?? '今天帮你做些什么？ 交给 Apolla，我来完成。'}
        className="w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[14.5px] outline-none placeholder:text-ink-faint leading-relaxed"
      />
      <div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
        <button className="w-8 h-8 rounded-lg hover:bg-line-soft flex items-center justify-center text-ink-soft">
          <IconPlus className="w-[18px] h-[18px]" />
        </button>

        <Select
          value={modelTier}
          onChange={(v) => setModelTier(v as ModelTier)}
          options={Object.entries(TIER_LABEL).map(([k, v]) => ({ value: k, label: v }))}
          prefix="模型"
        />
        <Select
          value={mode}
          onChange={(v) => setMode(v as PermissionMode)}
          options={Object.entries(MODE_LABEL).map(([k, v]) => ({ value: k, label: v }))}
          prefix="权限"
        />

        <div className="ml-auto flex items-center gap-1.5">
          {busy ? (
            <button
              onClick={onStop}
              className="w-9 h-9 rounded-full bg-ink hover:bg-ink/80 text-white flex items-center justify-center transition-colors"
              title="停止"
            >
              <IconStop className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!text.trim()}
              className="w-9 h-9 rounded-full bg-primary hover:bg-primary-hover disabled:bg-line disabled:text-ink-faint text-white flex items-center justify-center transition-colors"
              title="发送 (⌘↵)"
            >
              <IconSend className="w-[18px] h-[18px]" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
  prefix,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  prefix: string;
}) {
  return (
    <label className="flex items-center gap-1 h-8 px-2.5 rounded-lg hover:bg-line-soft cursor-pointer text-[12.5px] text-ink-soft">
      <span className="text-ink-faint">{prefix}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent outline-none cursor-pointer font-medium text-ink appearance-none pr-1"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
