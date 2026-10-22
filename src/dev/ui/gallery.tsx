import { useState } from "react";
import type { ReactNode } from "react";
import { ArrowLeftIcon, LoaderCircleIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PageFrame } from "@/components/layout/page-frame";
import { ThemeMenuToggle, ThemeToggle } from "@/components/layout/theme-toggle";
import { useTheme } from "@/lib/theme";

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="border-t border-border py-8 first:border-t-0 first:pt-0">
      <h2 className="text-base font-medium">{title}</h2>
      {note && <p className="mt-1 text-xs leading-6 text-muted-foreground">{note}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

/** 提交流程的演示：loading 期间按钮自己不可点，连点也只提交一次。 */
function PendingSubmitDemo() {
  const [pending, setPending] = useState(false);
  const [submits, setSubmits] = useState(0);

  function submit() {
    if (pending) return;
    setSubmits((count) => count + 1);
    setPending(true);
    window.setTimeout(() => setPending(false), 1500);
  }

  return (
    <Row>
      <Button onClick={submit} loading={pending}>
        {pending ? "正在提交…" : "提交"}
      </Button>
      <span className="text-xs text-muted-foreground" data-testid="submit-count">
        已提交 {submits} 次
      </span>
    </Row>
  );
}

function DialogDemo() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="secondary" />}>打开对话框</DialogTrigger>
      <DialogContent data-testid="gallery-dialog">
        <DialogHeader>
          <DialogTitle>移除这位 Agent？</DialogTitle>
          <DialogDescription>
            这是演示对话框，不会调用任何服务。Escape 或点击遮罩关闭后，焦点回到上面的按钮。
          </DialogDescription>
        </DialogHeader>
        <Field label="确认备注（演示）" hint="仅用于展示 Field 与 Dialog 的组合。">
          <Input placeholder="可留空" />
        </Field>
        <DialogFooter>
          <DialogTrigger render={<Button variant="secondary" />}>取消</DialogTrigger>
          <Button variant="destructive" onClick={() => setOpen(false)}>
            确认移除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Gallery() {
  const { theme } = useTheme();

  return (
    <PageFrame
      title="共享组件"
      description="I-P1/P2 UI 基础演示。页面使用与正式页面完全相同的组件与 token，数据与操作均为演示。"
      back={
        <a href="./" className="text-foreground">
          <Icon as={ArrowLeftIcon} />
          开发演示入口
        </a>
      }
      actions={<ThemeToggle />}
      testId="ui-gallery"
    >
      <Section
        title="主题"
        note="主题存在 localStorage；同一页面的多个切换点共享同一状态，刷新后保持。"
      >
        <Row>
          <Button variant="ghost" size="sm" data-testid="theme-readout">
            当前主题：{theme === "dark" ? "暗色" : "浅色"}
          </Button>
          <ThemeToggle />
        </Row>
        <Row>
          <div className="w-56 rounded-container border border-border bg-popover p-1.5">
            <ThemeMenuToggle />
          </div>
        </Row>
      </Section>

      <Section title="Icon" note="lucide-react，默认 16px / strokeWidth 1.5。">
        <Row>
          <Icon as={PlusIcon} />
          <Icon as={Trash2Icon} />
          <Icon as={LoaderCircleIcon} size={20} />
        </Row>
      </Section>

      <Section title="Button 变体" note="常规 34px / 6px 圆角；窄屏抬到 44px 触控高度。">
        <div className="flex flex-col gap-4">
          <Row>
            <Button>主要操作</Button>
            <Button variant="secondary">次要操作</Button>
            <Button variant="ghost">幽灵操作</Button>
            <Button variant="destructive">破坏性操作</Button>
            <Button variant="link">链接式操作</Button>
          </Row>
          <Row>
            <Button variant="secondary" size="sm">
              小号
            </Button>
            <Button variant="secondary" size="lg">
              大号
            </Button>
            <Button variant="secondary" size="icon" aria-label="新建">
              <Icon as={PlusIcon} />
            </Button>
            <Button variant="secondary" size="icon-sm" aria-label="删除">
              <Icon as={Trash2Icon} />
            </Button>
          </Row>
          <Row>
            <Button disabled>已禁用</Button>
            <Button variant="secondary" disabled>
              已禁用
            </Button>
          </Row>
          <PendingSubmitDemo />
        </div>
      </Section>

      <Section title="Field 与输入" note="说明与错误自动关联到控件，控件同步 aria-invalid。">
        <div className="grid max-w-xl gap-5">
          <Field label="Project 名称" htmlFor="gallery-name" hint="最多 80 字。">
            <Input id="gallery-name" defaultValue="Sprout Mio" maxLength={80} />
          </Field>
          <Field label="Agent 职位（省略 htmlFor）" error="职位最多 40 字。">
            <Input defaultValue="全能秘书兼这个字段超长之后的错误示例" />
          </Field>
          <Field label="人设" htmlFor="gallery-persona" hint="下一轮 run 才会使用新的人设。">
            <Textarea
              id="gallery-persona"
              defaultValue="负责整理 Daily 与周报，先给结论再给依据。"
            />
          </Field>
          <Field label="model" htmlFor="gallery-model" hint="留空即沿用宿主默认模型。">
            <Select id="gallery-model" defaultValue="">
              <option value="">使用默认</option>
              <option value="opus">opus</option>
              <option value="sonnet">sonnet</option>
            </Select>
          </Field>
          <Field label="不可编辑的字段" htmlFor="gallery-disabled" hint="禁用态的输入外观。">
            <Input id="gallery-disabled" defaultValue="只读事实" disabled />
          </Field>
        </div>
      </Section>

      <Section title="Dialog" note="Base UI 提供焦点进入与返回、Escape 与滚动锁定。">
        <DialogDemo />
      </Section>
    </PageFrame>
  );
}
