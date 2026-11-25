import type { ActionCard, FileDiff, MemoryChange, Rules, SnapshotRecord } from "@minder/cli/desktop";
export type { ActionCard, FileDiff, MemoryChange, Rules, SnapshotRecord };

export interface DesktopStatus {
  configured: boolean;
  root: string;
  provider: string;
  model: string;
  external: boolean;
  verified: boolean;
  busy: boolean;
  configurationIssue?: string;
}

export interface ProviderChoice {
  name: string;
  selectionId: string;
  providers: {id: string; models: string[]}[];
}

export interface DesktopSettings {
  root: string;
  provider: string;
  model: string;
  external: boolean;
  providerSelectionId?: string;
}

export type DesktopEvent =
  | {type: "delta"; text: string}
  | {type: "tool"; id: string; name: string; phase: "start" | "end"; failed?: boolean}
  | {type: "changed"};

export interface MinderDesktop {
  status(): Promise<DesktopStatus>;
  chooseWorkspace(): Promise<string | null>;
  chooseProvider(): Promise<ProviderChoice | null>;
  configure(settings: DesktopSettings): Promise<DesktopStatus & {changedConnection: boolean}>;
  openWebLink(url: string): Promise<void>;
  verify(): Promise<DesktopStatus>;
  send(text: string): Promise<void>;
  cancel(): Promise<void>;
  newChat(): Promise<void>;
  files(): Promise<SnapshotRecord[]>;
  diff(id: string): Promise<FileDiff>;
  undo(id: string): Promise<FileDiff>;
  pending(): Promise<{id:string; started:string; count:number}[]>;
  memoryDiff(session: string): Promise<MemoryChange[]>;
  review(session: string, key: string, accept: boolean): Promise<void>;
  inbox(): Promise<{title:string; events:ActionCard[]}[]>;
  accept(id: string, revision: string): Promise<{text:string; at:number}>;
  rules(): Promise<Rules>;
  saveRules(rules: Rules): Promise<Rules>;
  onEvent(handler: (event: DesktopEvent) => void): () => void;
}

export type MinderAPI = MinderDesktop;

declare global {
  interface Window { minder: MinderDesktop }
}
