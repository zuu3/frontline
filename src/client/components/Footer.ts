import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import { translateText } from "../Utils";

@customElement("page-footer")
export class Footer extends LitElement {
  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.waitForTranslations();
  }

  // translateText() reads the active language off document.querySelector
  // ("lang-selector") synchronously, but this component owns the app's only
  // <lang-selector> instance (see the comment on it below) -- so on first
  // paint it doesn't exist yet, and even once it does, its translations
  // load asynchronously. Neither event updates Footer's own render, since
  // Lit only re-renders a component when its own reactive state changes.
  // Poll each frame until translations are actually available, then
  // request one real update -- self-terminating, no interval to clean up.
  private waitForTranslations() {
    const check = () => {
      const langSelector = document.querySelector("lang-selector") as
        | { translations?: unknown; defaultTranslations?: unknown }
        | null;
      if (langSelector?.translations || langSelector?.defaultTranslations) {
        this.requestUpdate();
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }

  render() {
    return html`
      <footer
        class="[.in-game_&]:hidden bg-zinc-900/90 backdrop-blur-md flex flex-col items-center justify-center gap-1 pt-1 pb-3 text-white/50 w-full shrink-0 relative z-50 lg:grid lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-center lg:gap-0"
      >
        <!-- Bookends the nav bar's pixel-rule seam at the top of the page. -->
        <div class="pixel-rule w-full lg:col-span-3"></div>
        <!-- Icons and legal links stay centred on the bar: the flanking grid
             columns absorb any width difference so the center column never
             drifts off-center however wide a translation runs. -->
        <div
          class="flex w-full flex-col items-center gap-1 lg:col-start-2 lg:w-auto"
        >
          <div class="text-xs mt-2 flex items-center justify-center gap-4 px-4">
            <a
              href="/terms-of-service"
              target="_blank"
              class="hover:text-white transition-colors"
              >${translateText("main.terms_of_service")}</a
            >
            <span>${translateText("main.copyright")}</span>
            <a
              href="/privacy-policy"
              target="_blank"
              class="hover:text-white transition-colors"
              >${translateText("main.privacy_policy")}</a
            >
          </div>
        </div>

        <!-- Single instance: translateText() resolves the active language via
             document.querySelector("lang-selector"), so a second one would
             shadow it. -->
        <lang-selector
          class="absolute right-4 top-3 lg:top-1/2 lg:-translate-y-1/2"
        ></lang-selector>
      </footer>
    `;
  }
}
