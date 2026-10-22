import type { ReactNode } from "react";

/**
 * 设置页与 profile 页共用的小节：顶部细分隔线、14px 标题、必要说明。
 * 小节之间靠分隔与层级组织，不为每块内容套卡片。
 */
export function SettingsSection({
  title,
  description,
  actions,
  children,
  testId,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <section data-testid={testId} className={`border-t border-border py-6 ${className ?? ""}`}>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">{title}</h2>
          {description && (
            <p className="mt-1.5 text-xs leading-6 text-muted-foreground">{description}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** 只读事实列表：标签列固定宽度，值列允许长 ID 换行，不撑出横向滚动。 */
export function Facts({
  items,
}: {
  items: { label: string; testId?: string; value: ReactNode }[];
}) {
  return (
    <dl className="grid gap-y-1 text-xs leading-7">
      {items.map((item) => (
        <div key={item.label} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd data-testid={item.testId} className="min-w-0 break-words">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
