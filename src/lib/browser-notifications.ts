/**
 * 浏览器通知的薄封装。所有入口都对「不支持」与「未授权」安静降级：
 * 页面内 toast 已经兜底，调用方不需要为了权限问题写一堆 if。
 */

export type ChatNotificationInput = {
  title: string;
  body: string;
  /** 同一 tag 的通知会被浏览器合并，避免同一条对话刷屏。 */
  tag?: string;
};

export function browserNotificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (!browserNotificationsSupported()) return "unsupported";
  return window.Notification.permission;
}

export async function requestNotificationPermission(): Promise<
  NotificationPermission | "unsupported"
> {
  if (!browserNotificationsSupported()) return "unsupported";
  if (window.Notification.permission !== "default") return window.Notification.permission;
  try {
    return await window.Notification.requestPermission();
  } catch {
    return "denied";
  }
}

/** 只有拿到授权才真正弹系统通知；被拒、被策略拦住或构造失败都返回 false，不抛错。 */
export function showChatNotification(input: ChatNotificationInput): boolean {
  if (!browserNotificationsSupported() || window.Notification.permission !== "granted")
    return false;
  try {
    const notification = new window.Notification(input.title, {
      body: input.body,
      ...(input.tag === undefined ? {} : { tag: input.tag }),
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}
