import { useState } from "react";
import type { Project } from "../../contracts/project";
import { Button } from "../ui/button";
import { ProjectFormDialog } from "./project-form-dialog";
import { createProjectFn } from "../../server/functions/project";

/**
 * 新建 Project 的容器：server function 是边界，成功后把 Project 交给调用方，
 * 由调用方决定导航与刷新；这里不播种 Agent，也不做删除。
 */
export function CreateProjectDialog({ onCreated }: { onCreated: (project: Project) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button type="button" data-testid="new-project-trigger" onClick={() => setOpen(true)}>
        新建 Project
      </Button>
      <ProjectFormDialog
        open={open}
        onOpenChange={setOpen}
        submit={(values) => {
          const description = values.description.trim();
          return createProjectFn({
            data: { name: values.name, ...(description ? { description } : {}) },
          });
        }}
        onCreated={onCreated}
      />
    </>
  );
}
