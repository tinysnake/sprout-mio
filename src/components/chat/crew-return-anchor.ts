type CrewReturnAnchor = { messageId: string | null; offset: number; scrollTop: number };
const anchors = new Map<string, CrewReturnAnchor>();

export function rememberCrewReturn(chatId: string): void {
  const scroller = document.querySelector<HTMLElement>('[data-testid="message-history"]');
  if (!scroller) return;
  const top = scroller.getBoundingClientRect().top;
  const message = Array.from(scroller.querySelectorAll<HTMLElement>("[data-message-id]")).find(
    (item) => item.getBoundingClientRect().bottom > top,
  );
  anchors.set(chatId, {
    messageId: message?.dataset.messageId ?? null,
    offset: message ? message.getBoundingClientRect().top - top : 0,
    scrollTop: scroller.scrollTop,
  });
}

export function crewReturnAnchor(chatId: string): CrewReturnAnchor | undefined {
  return anchors.get(chatId);
}

export function clearCrewReturn(chatId: string): void {
  anchors.delete(chatId);
}
