import assert from "node:assert/strict";

class ChatElement extends EventTarget {
  dataset: Record<string, string | undefined> = {};
  children: ChatElement[] = [];
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  scrollTop = 0;
  scrollHeight = 0;
  isConnected = true;
  private _text = "";

  get textContent(): string {
    return this._text + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this._text = value;
    this.children = [];
  }

  appendChild(child: ChatElement): ChatElement {
    this.children.push(child);
    return child;
  }

  append(child: ChatElement): void {
    this.appendChild(child);
  }

  setAttribute(name: string, value: string): void {
    if (!name.startsWith("data-")) return;
    const key = name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    this.dataset[key] = value;
  }

  querySelector(selector: string): ChatElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): ChatElement[] {
    const matches = selector === "[data-message-content]" ? this.children.filter((child) => child.dataset.messageContent !== undefined) : [];
    return [...matches, ...this.children.flatMap((child) => child.querySelectorAll(selector))];
  }

  focus(): void {}

  remove(): void {
    this.isConnected = false;
  }
}

class ChatDocument extends EventTarget {
  visibilityState = "visible";
  body = new ChatElement();
  private _elements = new Map<string, ChatElement>();

  getElementById(id: string): ChatElement {
    const element = this._elements.get(id) ?? new ChatElement();
    this._elements.set(id, element);
    return element;
  }

  createElement(): ChatElement {
    return new ChatElement();
  }

  createElementNS(): ChatElement {
    return new ChatElement();
  }

  querySelector(): ChatElement {
    return this.getElementById("chat-stats");
  }

  querySelectorAll(): ChatElement[] {
    return [];
  }
}

const setGlobal = (key: string, value: unknown): (() => void) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return () => {
    if (original) Object.defineProperty(globalThis, key, original);
    else Reflect.deleteProperty(globalThis, key);
  };
};

const until = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  assert.fail("chat did not reach the expected authentication state");
};

for (const origin of ["http://localhost:8000", "https://chat.fixture.invalid"]) {
  Deno.test(`clearing a token cancels the pending auth check on ${origin}`, async () => {
    const documentTarget = new ChatDocument();
    const windowTarget = new EventTarget();
    const timers = new Map<number, { callback: () => void; delay: number }>();
    let nextHandle = 0;
    const authHeaders: string[] = [];
    const restore = [
      setGlobal("document", documentTarget),
      setGlobal("location", new URL(origin)),
      setGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} }),
      setGlobal("addEventListener", windowTarget.addEventListener.bind(windowTarget)),
      setGlobal("removeEventListener", windowTarget.removeEventListener.bind(windowTarget)),
      setGlobal("__uosNetworkTraceInstalled", true),
      setGlobal("setTimeout", (callback: () => void, delay = 0) => {
        nextHandle += 1;
        timers.set(nextHandle, { callback, delay });
        return nextHandle;
      }),
      setGlobal("clearTimeout", (handle: number) => timers.delete(handle)),
      setGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(input instanceof Request ? input.url : input).pathname;
        const authorization = new Headers(init?.headers).get("Authorization") ?? "";
        let body: unknown;
        if (path === "/uos/auth") {
          authHeaders.push(authorization);
          body = { auth: { mode: authorization ? "kv_api_key" : "disabled", is_admin: true, is_super_admin: true } };
        } else if (path === "/admin/defaults") {
          body = { defaults: { model: "fixture-model" } };
        } else if (path === "/v1/models" || path === "/uos/models/capabilities") {
          body = { data: [{ id: "fixture-model" }] };
        } else {
          throw new Error(`unexpected network request: ${path}`);
        }
        return Promise.resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
      }),
    ];
    try {
      if (origin.startsWith("http:")) await import("../static/chat.js?auth-debounce-local");
      else await import("../static/chat.js?auth-debounce-remote");
      const token = documentTarget.getElementById("token");
      const badge = documentTarget.getElementById("auth-badge");
      const model = documentTarget.getElementById("model");
      if (origin.startsWith("http:")) await until(() => model.value === "fixture-model");
      else await until(() => badge.textContent === "Missing token");

      token.value = "pending-token";
      token.dispatchEvent(new Event("input"));
      token.value = "";
      token.dispatchEvent(new Event("input"));
      if (origin.startsWith("http:")) await until(() => model.value === "fixture-model" && !model.disabled);
      else await until(() => badge.textContent === "Missing token");
      const authCallsBeforeTimers = authHeaders.length;
      for (const [handle, timer] of [...timers]) {
        timers.delete(handle);
        timer.callback();
      }
      assert.equal(authHeaders.length, authCallsBeforeTimers);
      if (origin.startsWith("http:")) {
        assert.equal(badge.textContent, "Local super admin");
        assert.equal(model.disabled, false);
        assert.equal(model.value, "fixture-model");
        assert.equal(documentTarget.getElementById("passkey-login").hidden, true);
      } else {
        assert.equal(badge.textContent, "Missing token");
        assert.equal(model.disabled, true);
      }

      // Subsequent non-empty edits still coalesce into one check of the latest token.
      token.value = "first-token";
      token.dispatchEvent(new Event("input"));
      token.value = "latest-token";
      token.dispatchEvent(new Event("input"));
      const callsBeforeTokenCheck = authHeaders.length;
      for (const [handle, timer] of [...timers]) {
        timers.delete(handle);
        timer.callback();
      }
      await until(() => badge.textContent === "OK (kv_api_key)");
      assert.deepEqual(authHeaders.slice(callsBeforeTokenCheck), ["Bearer latest-token"]);
    } finally {
      for (const restoreGlobal of restore.toReversed()) restoreGlobal();
    }
  });
}
