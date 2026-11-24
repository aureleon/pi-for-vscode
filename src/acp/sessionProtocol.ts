export interface AcpImage {
  type: "image";
  mimeType: string;
  data: string;
}

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_TOTAL = 16 * 1024 * 1024;
export const ACP_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface AcpConfigChoice {
  id: string;
  category?: string;
  name: string;
  value: string;
  options: { value: string; label: string; description?: string }[];
}

export interface AcpComposer {
  images: boolean;
  model?: string;
  effort?: string;
  config: boolean;
  usage?: number;
  compact: boolean;
  commands: { name: string; description?: string }[];
  canTitle: boolean;
}

export type AcpInput =
  | { type: "ready" | "abort" | "restart" | "acp_close" }
  | { type: "prompt"; text: string; images?: AcpImage[] }
  | { type: "acpCompact" | "acpTitleRequest" }
  | { type: "acpSetConfig"; id: string; value: string }
  | { type: "rename"; name: string }
  | { type: "permissionAnswer"; id: string; option?: string };

export interface PermissionRequest {
  title: string;
  detail?: string;
  options: { label: string; description: string; id: string }[];
}

export type AcpOutput =
  | { type: "acpComposer"; capabilities: AcpComposer; choices: AcpConfigChoice[] }
  | { type: "acpOperation"; message: string }
  | { type: "permission"; id: string; request: PermissionRequest }
  | { type: "permissionClosed"; id: string }
  | { type: "acpTitle"; title: string; busy: boolean }
  | { type: "acpStatus"; ready: boolean; error?: string }
  | { type: "starting" }
  | { type: "init"; cwd: string; messages: unknown[]; state: { sessionName: string; isStreaming: boolean } }
  | { type: "state"; state: { sessionName: string } }
  | { type: "event"; event: { type: string } }
  | { type: "error"; message: string };
