import type { ReactNode } from "react";

type PageFrameProps = {
  title: ReactNode;
  description?: ReactNode;
  /** 返回目标，通常是路由 `<Link>` 节点；没有实际返回目标时省略。 */
  back?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  testId?: string;
};

/**
 * 普通管理页共用的页面标题区：一个返回入口、一个 h1、必要说明与页面操作。
 * 两层缩进与设计基线一致：外层负责 40/48px 内边距与窄屏收窄，内层只负责
 * 960px 内容宽并居中，所以标题起点跟随视口而不是被 max-width 一起推右。
 */
export function PageFrame({ title, description, back, actions, children, testId }: PageFrameProps) {
  return (
    <section
      data-testid={testId}
      className="flex min-h-0 flex-1 flex-col overflow-auto bg-background text-foreground"
    >
      <div className="flex flex-1 flex-col px-12 py-10 max-desktop:px-5 max-desktop:py-6">
        <div className="mx-auto w-full max-w-240">
          {/* back 是 link 节点，44px 触控高度由这个插槽统一给出，调用方不必各写一份。 */}
          {back && (
            <div className="mb-4 flex min-h-11 items-center text-xs leading-normal [&>*]:inline-flex [&>*]:min-h-11 [&>*]:items-center [&>*]:gap-2">
              {back}
            </div>
          )}
          <header className="mb-8 max-desktop:mb-6">
            <div className="flex items-start justify-between gap-3">
              <h1
                tabIndex={-1}
                className="text-2xl leading-[1.4] font-semibold tracking-[-0.02em] outline-none"
              >
                {title}
              </h1>
              {actions && (
                <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
              )}
            </div>
            {description && (
              <p className="mt-2 text-[13px] leading-[1.6] text-muted-foreground">{description}</p>
            )}
          </header>
          {children}
        </div>
      </div>
    </section>
  );
}
