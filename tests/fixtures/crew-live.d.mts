import type { Chat, ChatMemberInput } from "../../src/contracts/chat";
export function createCrewFixture(
  call: (name: string, input: unknown) => Promise<unknown>,
  database: string,
  input: {
    projectId: string;
    title?: string;
    members: ChatMemberInput[];
    initialOwner?: { kind: "human" | "agent"; id: string };
  },
): Promise<Chat>;
