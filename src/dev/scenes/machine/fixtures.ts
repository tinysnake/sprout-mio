import { projectWorkingPath } from "../../../contracts/machine";
import type { MachineDetail, MachineEnrollment } from "../../../contracts/machine";
import { DEMO_REQUEST_ID, demoProject } from "../management/fixtures";

export const machineProject = { id: demoProject.id, name: demoProject.name };
export const secondProject = {
  id: "prj_99999999-9999-4999-8999-999999999999",
  name: "第二个 Project",
};

export const demoMachineIds = [
  "mch_11111111-1111-4111-8111-111111111111",
  "mch_22222222-2222-4222-8222-222222222222",
  "mch_33333333-3333-4333-8333-333333333333",
  "mch_44444444-4444-4444-8444-444444444444",
  "mch_55555555-5555-4555-8555-555555555555",
] as const;

export const demoMachineDetails: MachineDetail[] = [
  {
    machine: {
      id: demoMachineIds[0],
      rootDirectory: "/Users/linche/workspace",
      rootRevision: 2,
      name: "工作室 Mac mini",
      createdBy: "demo-human",
      createdAt: "2026-10-10T02:00:00.000Z",
      updatedAt: "2026-10-18T06:40:00.000Z",
    },
    enrollmentStatus: "active",
    connection: {
      kind: "online",
      generation: 3,
      lastSeenAt: "2026-10-18T07:11:30.000Z",
    },
    capability: {
      generation: 3,
      current: true,
      snapshot: {
        platform: "darwin",
        arch: "arm64",
        workerVersion: "0.4.2",
        shells: [
          {
            path: "/bin/zsh",
            kind: "zsh",
            version: "zsh 5.9",
            checkedAt: "2026-10-18T07:10:00.000Z",
            probe: { kind: "success" },
          },
          {
            path: "/bin/bash",
            kind: "bash",
            version: "GNU bash, version 3.2.57",
            checkedAt: "2026-10-18T07:10:00.000Z",
            probe: { kind: "success" },
          },
          {
            path: "/bin/sh",
            kind: "sh",
            version: "sh 3.2.57",
            checkedAt: "2026-10-18T07:10:00.000Z",
            probe: { kind: "success" },
          },
        ],
        remoteOperations: "not_implemented",
      },
    },
    bindings: [
      {
        intent: {
          projectId: demoProject.id,
          machineId: demoMachineIds[0],
          description: "日常开发与验收使用的本机目录。",
          revision: 2,
        },
        observation: {
          current: true,
          fact: {
            machineId: demoMachineIds[0],
            generation: 3,
            projectId: demoProject.id,
            revision: 2,
            seq: 18,
            checkedAt: "2026-10-18T07:09:00.000Z",
            result: {
              kind: "accessible",
              realPath: projectWorkingPath("/Users/linche/workspace", demoProject.id),
            },
          },
        },
      },
    ],
  },
  {
    machine: {
      id: demoMachineIds[1],
      rootDirectory: null,
      rootRevision: 1,
      name: "待配对的 MacBook",
      createdBy: "demo-human",
      createdAt: "2026-10-18T06:50:00.000Z",
      updatedAt: "2026-10-18T06:50:00.000Z",
    },
    enrollmentStatus: "pending",
    connection: {
      kind: "offline",
      generation: null,
      lastSeenAt: null,
      reason: "never_connected",
    },
    capability: null,
    bindings: [],
  },
  {
    machine: {
      id: demoMachineIds[2],
      rootDirectory: "/Users/linche/workspace",
      rootRevision: 1,
      name: "刚唤醒的 Mac Studio",
      createdBy: "demo-human",
      createdAt: "2026-10-12T09:00:00.000Z",
      updatedAt: "2026-10-18T07:12:00.000Z",
    },
    enrollmentStatus: "active",
    connection: {
      kind: "connecting",
      generation: 4,
      lastSeenAt: "2026-10-18T07:12:02.000Z",
    },
    capability: null,
    bindings: [
      {
        intent: {
          projectId: demoProject.id,
          machineId: demoMachineIds[2],
          description: "重型构建。",
          revision: 1,
        },
        observation: null,
      },
    ],
  },
  {
    machine: {
      id: demoMachineIds[3],
      rootDirectory:
        "/Users/linche/workspace/experiments/very-long-directory-name-for-narrow-layout-check/nested",
      rootRevision: 5,
      name: "断线的旧代次 MacBook Pro",
      createdBy: "demo-human",
      createdAt: "2026-09-01T02:00:00.000Z",
      updatedAt: "2026-10-17T23:20:00.000Z",
    },
    enrollmentStatus: "active",
    connection: {
      kind: "offline",
      generation: 2,
      lastSeenAt: "2026-10-17T23:15:00.000Z",
      reason: "stale",
    },
    capability: {
      generation: 2,
      current: false,
      snapshot: {
        platform: "darwin",
        arch: "x64",
        workerVersion: "0.4.1",
        shells: [
          {
            path: "/bin/zsh",
            kind: "zsh",
            version: "zsh 5.8.1",
            checkedAt: "2026-10-17T23:10:00.000Z",
            probe: { kind: "success" },
          },
          {
            path: "/usr/local/bin/fish",
            kind: "unknown",
            version: null,
            checkedAt: "2026-10-17T23:10:00.000Z",
            probe: { kind: "failure", reason: "unsupported" },
          },
        ],
        remoteOperations: "not_implemented",
      },
    },
    bindings: [
      {
        intent: {
          projectId: demoProject.id,
          machineId: demoMachineIds[3],
          description: "旧目录，等待 Worker 在新代次重新验证。",
          revision: 5,
        },
        observation: {
          current: false,
          fact: {
            machineId: demoMachineIds[3],
            generation: 2,
            projectId: demoProject.id,
            revision: 4,
            seq: 41,
            checkedAt: "2026-10-17T22:55:00.000Z",
            result: { kind: "unavailable", reason: "missing" },
          },
        },
      },
      {
        intent: {
          projectId: secondProject.id,
          machineId: demoMachineIds[3],
          description: "旧 Project 的绑定，仍显示事实但标注旧观察。",
          revision: 1,
        },
        observation: {
          current: false,
          fact: {
            machineId: demoMachineIds[3],
            generation: 2,
            projectId: secondProject.id,
            revision: 1,
            seq: 12,
            checkedAt: "2026-10-17T22:50:00.000Z",
            result: {
              kind: "accessible",
              realPath: projectWorkingPath("/Users/linche/workspace/legacy", secondProject.id),
            },
          },
        },
      },
    ],
  },
  {
    machine: {
      id: demoMachineIds[4],
      rootDirectory: null,
      rootRevision: 1,
      name: "已关闭连接的待配对设备",
      createdBy: "demo-human",
      createdAt: "2026-10-16T04:00:00.000Z",
      updatedAt: "2026-10-17T04:00:00.000Z",
    },
    enrollmentStatus: "pending",
    connection: {
      kind: "offline",
      generation: 1,
      lastSeenAt: "2026-10-17T03:55:00.000Z",
      reason: "closed",
    },
    capability: null,
    bindings: [],
  },
];

export function demoEnrollment(
  detail: MachineDetail,
  ticket = "DEMO".padEnd(43, "A"),
): MachineEnrollment {
  return {
    detail,
    ticket,
    expiresAt: "2026-10-18T08:00:00.000Z",
  };
}

export const demoProjectNames = {
  [demoProject.id]: demoProject.name,
  [secondProject.id]: secondProject.name,
};

export { DEMO_REQUEST_ID, demoProject };
