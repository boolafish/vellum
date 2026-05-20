export type DiscardChoice = "save" | "dont-save" | "cancel";

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

/**
 * Native-style 3-button "unsaved changes" sheet. The Tauri dialog plugin only
 * offers 2 buttons, so we render our own to get the standard
 * Save / Don't Save / Cancel choice with proper keyboard handling
 * (Enter = Save, Esc = Cancel). Resolves once; only one can be open at a time.
 */
export function confirmUnsavedChanges(name: string): Promise<DiscardChoice> {
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
          <button type="button" data-choice="dont-save" class="modal-btn ghost">Don’t Save</button>
          <span class="modal-spacer"></span>
          <button type="button" data-choice="cancel" class="modal-btn">Cancel</button>
          <button type="button" data-choice="save" class="modal-btn primary">Save</button>
        </div>
      </div>`;

    const finish = (choice: DiscardChoice) => {
      window.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(choice);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish("save");
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish("cancel");
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
