import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";

export type ToastVariant = "success" | "error";

interface ToastEntry {
  id: number;
  message: string;
  variant: ToastVariant;
}

const TOAST_EVENT = "toast";
const AUTO_DISMISS_MS = 3500;
let nextId = 0;

/**
 * Fires a toast notification. Callable from anywhere -- Lit components and
 * plain modules alike (WebSocket handlers, imperative flows) -- the same way
 * showInGameAlert()/showInGameConfirm() (InGameModal.ts) are: a window event
 * decouples the caller from needing a reference to <toast-host>. Replaces the
 * native `alert()` used throughout the app for success/failure feedback
 * (store purchases, account actions, etc.) with a non-blocking, auto-dismissing
 * notification instead of a dialog the player must click through.
 */
export function showToast(message: string, variant: ToastVariant = "success"): void {
  window.dispatchEvent(
    new CustomEvent<ToastEntry>(TOAST_EVENT, {
      detail: { id: nextId++, message, variant },
    }),
  );
}

/**
 * Fixed bottom-right stack of auto-dismissing toasts. Mount exactly one
 * <toast-host> (see index.html); every showToast() call anywhere in the app
 * reaches it via the window "toast" event.
 */
@customElement("toast-host")
export class ToastHost extends LitElement {
  @state() private toasts: ToastEntry[] = [];

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener(TOAST_EVENT, this.onToast);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener(TOAST_EVENT, this.onToast);
  }

  private onToast = (e: Event) => {
    const entry = (e as CustomEvent<ToastEntry>).detail;
    this.toasts = [...this.toasts, entry];
    setTimeout(() => this.dismiss(entry.id), AUTO_DISMISS_MS);
  };

  private dismiss(id: number) {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  render() {
    if (this.toasts.length === 0) return nothing;
    return html`
      <div
        class="fixed bottom-4 right-4 z-[10000] flex flex-col gap-2 w-auto max-w-[calc(100vw-2rem)] sm:max-w-[320px]"
      >
        ${this.toasts.map(
          (t) => html`
            <div
              role="status"
              class="flex items-start gap-2 bg-surface border rounded-xl shadow-lg px-3 py-2.5 ${t.variant ===
              "error"
                ? "border-frontline-red-dim/50"
                : "border-emerald-500/40"}"
            >
              <div
                class="shrink-0 mt-0.5 w-2 h-2 rounded-full ${t.variant ===
                "error"
                  ? "bg-frontline-red-hover"
                  : "bg-emerald-400"}"
              ></div>
              <div class="flex-1 min-w-0 text-[13px] leading-snug text-white/90">
                ${t.message}
              </div>
              <button
                class="shrink-0 grid place-items-center w-5 h-5 -mt-0.5 -mr-0.5 rounded-md text-white/40 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
                @click=${() => this.dismiss(t.id)}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  aria-hidden="true"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          `,
        )}
      </div>
    `;
  }
}
