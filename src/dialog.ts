export type DiscardChoice = "save" | "dont-save" | "cancel";

let modalOpen = false;

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

/**
 * Native-style 3-button "unsaved changes" sheet. The Tauri dialog plugin only
 * offers 2 buttons, so we render our own to get the standard
 * Save / Don't Save / Cancel choice with proper keyboard behavior:
 *   - Enter activates the focused button (defaults to Save),
 *   - Esc cancels,
 *   - Tab is trapped within the sheet, and focus is restored on close.
 * Only one sheet can be open at a time.
 */
export function confirmUnsavedChanges(name: string): Promise<DiscardChoice> {
  if (modalOpen) return Promise.resolve("cancel");
  modalOpen = true;
  const previouslyFocused = document.activeElement as HTMLElement | null;

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <p id="modal-title" class="modal-title">Do you want to save the changes you made to “${escapeHtml(
          name,
        )}”?</p>
        <p class="modal-body">Your changes will be lost if you don’t save them.</p>
        <div class="modal-actions">
          <button type="button" data-choice="dont-save" class="modal-btn">Don’t Save</button>
          <span class="modal-spacer"></span>
          <button type="button" data-choice="cancel" class="modal-btn">Cancel</button>
          <button type="button" data-choice="save" class="modal-btn primary">Save</button>
        </div>
      </div>`;

    const buttons = Array.from(overlay.querySelectorAll<HTMLButtonElement>(".modal-btn"));

    const finish = (choice: DiscardChoice) => {
      window.removeEventListener("keydown", onKey, true);
      overlay.remove();
      modalOpen = false;
      previouslyFocused?.focus?.();
      resolve(choice);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish("cancel");
      } else if (e.key === "Enter") {
        e.preventDefault();
        const active = document.activeElement as HTMLElement | null;
        const choice = active?.dataset?.choice as DiscardChoice | undefined;
        finish(choice ?? "save");
      } else if (e.key === "Tab") {
        // Trap focus within the three buttons.
        e.preventDefault();
        const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const delta = e.shiftKey ? -1 : 1;
        const next = (idx + delta + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    };

    overlay.addEventListener("mousedown", (e) => {
      const choice = (e.target as HTMLElement).dataset.choice as DiscardChoice | undefined;
      if (choice) finish(choice);
    });

    window.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
    overlay.querySelector<HTMLButtonElement>(".primary")!.focus();
  });
}
