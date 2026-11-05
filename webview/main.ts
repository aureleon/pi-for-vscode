import { mountChat, type ChatApi } from "./chat";
import { mountTiles } from "./tiles";

declare function acquireVsCodeApi(): ChatApi;
const vscode = acquireVsCodeApi();
const data = document.body.dataset;

// The sidebar holds one or more chats in tiles. Editor tabs and the session viewer hold one chat.
if (data.tiles) {
  mountTiles(vscode, data.logo ?? "");
} else {
  const frame = document.createElement("div");
  document.body.appendChild(frame);
  const chat = mountChat(frame, vscode, { header: !!data.header, readonly: !!data.readonly, logo: data.logo });
  window.addEventListener("message", (ev) => chat.receive(ev.data));
}
