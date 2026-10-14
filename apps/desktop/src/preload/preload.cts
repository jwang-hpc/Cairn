// Preload (CommonJS: a sandboxed preload can't load ES modules or other files, so the channel names are spelled out
// here; a test checks they match src/shared/bridge.ts). Exposes window.cairn and nothing else.
import electron = require("electron");
import type { IpcRendererEvent } from "electron";
import type { CairnBridge, EngineConnection, EngineEvent, EngineRequest } from "../shared/bridge.js";

const { contextBridge, ipcRenderer } = electron;
const REQUEST = "cairn:request";
const CONNECTION = "cairn:connection";
const RECONNECT = "cairn:reconnect";
const EVENT = "cairn:event";
const CONNECTION_CHANGED = "cairn:connection-changed";

const bridge: CairnBridge = {
  request: (r: EngineRequest) => ipcRenderer.invoke(REQUEST, r),
  connection: () => ipcRenderer.invoke(CONNECTION),
  reconnect: () => ipcRenderer.invoke(RECONNECT),
  subscribe(handlers) {
    const onEvent = (_e: IpcRendererEvent, data: EngineEvent) => handlers.event?.(data);
    const onConnection = (_e: IpcRendererEvent, data: EngineConnection) => handlers.connection?.(data);
    ipcRenderer.on(EVENT, onEvent);
    ipcRenderer.on(CONNECTION_CHANGED, onConnection);
    return () => {
      ipcRenderer.removeListener(EVENT, onEvent);
      ipcRenderer.removeListener(CONNECTION_CHANGED, onConnection);
    };
  },
};

contextBridge.exposeInMainWorld("cairn", bridge);
