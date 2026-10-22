import { useState } from "react";
import type { AgentProfile } from "../../contracts/agent";
import { Button } from "../ui/button";
import { AgentFormDialog } from "./agent-form-dialog";
import { createAgentProfileFn } from "../../server/functions/agent";

/** 新建 Agent profile 的边界是 server function；界面由 AgentFormDialog 共用。 */
export function CreateAgentDialog({ onCreated }: { onCreated: (profile: AgentProfile) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button type="button" data-testid="new-agent-trigger" onClick={() => setOpen(true)}>
        新建 Agent
      </Button>
      <AgentFormDialog
        open={open}
        onOpenChange={setOpen}
        submit={(values) =>
          createAgentProfileFn({
            data: {
              name: values.name,
              ...(values.jobTitle.trim() ? { jobTitle: values.jobTitle.trim() } : {}),
              persona: values.persona,
            },
          })
        }
        onCreated={onCreated}
      />
    </>
  );
}
