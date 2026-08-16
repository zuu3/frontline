import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  CLAN_CREATE_COST_SOFT,
  type ClanBrowseResponse,
  createClan,
  fetchClans,
} from "../../ClanApi";
import { getUserMe, invalidateUserMe } from "../../Api";
import type { InsufficientCurrency } from "../../Cosmetics";
import { translateText } from "../../Utils";
import "./ClanCard";
import "../CapIcon";
import "../InsufficientCurrencyDialog";
import { type ClanRole, renderLoadingSpinner } from "./ClanShared";

export interface BrowseState {
  data: ClanBrowseResponse | null;
  page: number;
  query: string;
}

@customElement("clan-browse-view")
export class ClanBrowseView extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ type: Object }) myClanRoles: Map<string, ClanRole> = new Map();
  @property({ type: Array }) myPendingRequests: { tag: string }[] = [];
  @property({ type: Object }) cachedState: BrowseState | null = null;

  @state() private searchQuery = "";
  @state() private browseData: ClanBrowseResponse | null = null;
  @state() private browsePage = 1;
  @state() private loading = false;
  @state() private errorMsg = "";
  private searchDebounce: ReturnType<typeof setTimeout> | null = null;
  private asyncGeneration = 0;

  @state() private showCreateForm = false;
  @state() private createTag = "";
  @state() private createName = "";
  @state() private createDescription = "";
  @state() private createOpen = true;
  @state() private creating = false;
  @state() private createError = "";
  @state() private insufficientInfo: InsufficientCurrency | null = null;

  private emitState() {
    this.dispatchEvent(
      new CustomEvent("browse-updated", {
        detail: {
          data: this.browseData,
          page: this.browsePage,
          query: this.searchQuery,
        } satisfies BrowseState,
        bubbles: true,
        composed: true,
      }),
    );
  }

  async loadBrowse() {
    const gen = ++this.asyncGeneration;
    this.loading = true;
    this.errorMsg = "";
    try {
      const data = await fetchClans(
        this.searchQuery || undefined,
        this.browsePage,
      );
      if (gen !== this.asyncGeneration) return;
      if (data === false) throw new Error("fetch failed");
      this.browseData = data;
      this.emitState();
    } catch {
      if (gen !== this.asyncGeneration) return;
      this.errorMsg = translateText("clan_modal.error_loading");
    } finally {
      if (gen === this.asyncGeneration) this.loading = false;
    }
  }

  private onSearchInput(e: Event) {
    this.searchQuery = (e.target as HTMLInputElement).value;
    if (this.searchDebounce) clearTimeout(this.searchDebounce);
    this.searchDebounce = setTimeout(() => {
      this.browsePage = 1;
      this.loadBrowse();
    }, 400);
  }

  connectedCallback() {
    super.connectedCallback();
    if (this.cachedState?.data) {
      this.browseData = this.cachedState.data;
      this.browsePage = this.cachedState.page;
      this.searchQuery = this.cachedState.query;
    } else {
      this.loadBrowse();
    }
  }

  disconnectedCallback() {
    if (this.searchDebounce) clearTimeout(this.searchDebounce);
    super.disconnectedCallback();
  }

  private async handleCreate() {
    if (this.creating) return;
    const tag = this.createTag.trim().toUpperCase();
    const name = this.createName.trim();
    if (!/^[A-Z0-9]{2,5}$/.test(tag)) {
      this.createError = translateText("clan_modal.create_invalid_tag");
      return;
    }
    if (!name) {
      this.createError = translateText("clan_modal.create_name_required");
      return;
    }
    this.creating = true;
    this.createError = "";
    const result = await createClan(
      tag,
      name,
      this.createDescription.trim(),
      this.createOpen,
    );
    this.creating = false;
    if ("error" in result) {
      if (result.error === "clan_modal.create_insufficient_funds") {
        this.insufficientInfo = {
          currency: translateText("cosmetics.soft"),
          shortfall: CLAN_CREATE_COST_SOFT,
          item: name,
          canTopUp: false,
        };
      } else {
        this.createError = translateText(result.error);
      }
      return;
    }
    this.showCreateForm = false;
    this.createTag = "";
    this.createName = "";
    this.createDescription = "";
    this.createOpen = true;
    // Same refresh-in-place pattern as the store purchase flow (Cosmetics.ts)
    // -- every listener (this modal's own myClans, the nav currency badge,
    // etc.) already re-renders itself from this event.
    invalidateUserMe();
    const fresh = await getUserMe();
    document.dispatchEvent(
      new CustomEvent("userMeResponse", {
        detail: fresh,
        bubbles: true,
        cancelable: true,
      }),
    );
    this.dispatchEvent(
      new CustomEvent("clan-select", {
        detail: { tag: result.tag },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private renderCreateForm() {
    if (!this.showCreateForm) {
      return html`
        <button
          @click=${() => (this.showCreateForm = true)}
          class="w-full flex items-center justify-center gap-2 px-4 py-3 text-sm font-bold text-white uppercase tracking-wider pixel-notch bg-frontline-red-dim hover:bg-frontline-red-hover rounded-xl transition-all"
        >
          ${translateText("clan_modal.create_clan")}
          <span class="inline-flex items-center gap-1 text-xs font-normal opacity-80">
            (<cap-icon .size=${14}></cap-icon>${CLAN_CREATE_COST_SOFT})
          </span>
        </button>
      `;
    }
    return html`
      <div class="space-y-3 p-4 bg-white/5 border border-white/10 rounded-xl">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-bold text-white uppercase tracking-wider">
            ${translateText("clan_modal.create_clan")}
          </h3>
          <button
            @click=${() => {
              this.showCreateForm = false;
              this.createError = "";
            }}
            class="text-white/40 hover:text-white text-xs"
          >
            ${translateText("common.cancel")}
          </button>
        </div>
        <input
          type="text"
          .value=${this.createTag}
          @input=${(e: Event) =>
            (this.createTag = (e.target as HTMLInputElement).value
              .toUpperCase()
              .slice(0, 5))}
          maxlength="5"
          placeholder="${translateText("clan_modal.create_tag_placeholder")}"
          class="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white placeholder-white/20 text-sm font-mono uppercase tracking-widest"
        />
        <input
          type="text"
          .value=${this.createName}
          @input=${(e: Event) =>
            (this.createName = (e.target as HTMLInputElement).value.slice(
              0,
              35,
            ))}
          maxlength="35"
          placeholder="${translateText("clan_modal.create_name_placeholder")}"
          class="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white placeholder-white/20 text-sm"
        />
        <textarea
          .value=${this.createDescription}
          @input=${(e: Event) =>
            (this.createDescription = (
              e.target as HTMLTextAreaElement
            ).value.slice(0, 200))}
          maxlength="200"
          rows="2"
          placeholder="${translateText(
            "clan_modal.create_description_placeholder",
          )}"
          class="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-lg text-white placeholder-white/20 text-sm resize-none"
        ></textarea>
        <label class="flex items-center gap-2 text-sm text-white/70">
          <input
            type="checkbox"
            .checked=${this.createOpen}
            @change=${(e: Event) =>
              (this.createOpen = (e.target as HTMLInputElement).checked)}
          />
          ${translateText("clan_modal.create_open_label")}
        </label>
        ${this.createError
          ? html`<p class="text-red-400 text-xs">${this.createError}</p>`
          : ""}
        <button
          @click=${() => this.handleCreate()}
          ?disabled=${this.creating}
          class="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-bold text-white uppercase tracking-wider pixel-notch bg-frontline-red-dim hover:bg-frontline-red-hover disabled:opacity-50 rounded-lg transition-all"
        >
          ${translateText("clan_modal.create_submit")}
          <span class="inline-flex items-center gap-1 text-xs font-normal opacity-80">
            (<cap-icon .size=${14}></cap-icon>${CLAN_CREATE_COST_SOFT})
          </span>
        </button>
      </div>
      <insufficient-currency-dialog
        .info=${this.insufficientInfo}
        @close=${() => (this.insufficientInfo = null)}
      ></insufficient-currency-dialog>
    `;
  }

  render() {
    if (this.loading && !this.browseData) return renderLoadingSpinner();

    const totalPages = this.browseData
      ? Math.ceil(this.browseData.total / this.browseData.limit)
      : 0;
    const pendingTags = new Set(this.myPendingRequests.map((r) => r.tag));
    const filtered = (this.browseData?.results ?? []).filter(
      (clan) => !this.myClanRoles.has(clan.tag),
    );

    return html`
      <div class="space-y-4">
        ${this.renderCreateForm()}
        <div class="relative">
          <input
            type="text"
            .value=${this.searchQuery}
            @input=${(e: Event) => this.onSearchInput(e)}
            class="w-full pl-10 pr-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/20 focus:outline-none focus:ring-2 focus:ring-frontline-red-hover/50 focus:border-frontline-red-dim/50 transition-all font-medium hover:bg-white/10 text-sm"
            placeholder="${translateText("clan_modal.search_placeholder")}"
          />
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="w-4 h-4 text-white/30 absolute left-3 top-1/2 -translate-y-1/2"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="2"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
        </div>

        ${this.errorMsg
          ? html`<p class="text-red-400 text-sm text-center py-4">
              ${this.errorMsg}
            </p>`
          : ""}

        <div class="space-y-3">
          ${filtered.length === 0 && this.browseData
            ? html`<p class="text-white/40 text-sm text-center py-8">
                ${translateText("clan_modal.no_results")}
              </p>`
            : filtered.map(
                (clan) =>
                  html`<clan-card
                    .clan=${clan}
                    ?pending=${pendingTags.has(clan.tag)}
                  ></clan-card>`,
              )}
        </div>

        ${totalPages > 1
          ? html`
              <div class="flex items-center justify-center gap-2 pt-2">
                <button
                  @click=${() => {
                    this.browsePage = Math.max(1, this.browsePage - 1);
                    this.loadBrowse();
                  }}
                  ?disabled=${this.browsePage <= 1}
                  class="px-2 py-1 text-xs font-bold rounded-lg transition-all ${this
                    .browsePage <= 1
                    ? "text-white/20 cursor-not-allowed"
                    : "text-white/60 hover:text-white hover:bg-white/10"}"
                >
                  &lt;
                </button>
                <span class="text-xs text-white/50 font-medium">
                  ${this.browsePage} / ${totalPages}
                </span>
                <button
                  @click=${() => {
                    this.browsePage = Math.min(totalPages, this.browsePage + 1);
                    this.loadBrowse();
                  }}
                  ?disabled=${this.browsePage >= totalPages}
                  class="px-2 py-1 text-xs font-bold rounded-lg transition-all ${this
                    .browsePage >= totalPages
                    ? "text-white/20 cursor-not-allowed"
                    : "text-white/60 hover:text-white hover:bg-white/10"}"
                >
                  &gt;
                </button>
              </div>
            `
          : ""}
      </div>
    `;
  }
}
