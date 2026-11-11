export function Portal({ size, label, circle }: { size: number; label?: string; circle?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : "true"} class={circle ? "portal circle" : "portal"}>
      <path fill="#0A2F1D" d="M0 0h128v128H0z" />
      <path fill="#FDFBF7" d="M30 96V59a34 34 0 0 1 68 0v37H30Z" />
      <path fill="#17462F" d="M39 87h50V59a25 25 0 0 0-50 0v28Z" />
      <circle fill="#D4AF37" cx="69" cy="53" r="6" />
      <path fill="#759581" d="M39 78.5c15-8.5 34-10.5 50-4.5v13H39Z" />
    </svg>
  );
}

export function Chevron() {
  return (
    <svg width="7" height="12" viewBox="0 0 7 12" fill="none" stroke="var(--secondary)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m1 1 5 5-5 5" /></svg>
  );
}

export function Alert({ title, message, cancel, confirm, onCancel, onConfirm }: {
  title: string;
  message: string;
  cancel: string;
  confirm?: string;
  onCancel: () => void;
  onConfirm?: () => void;
}) {
  return (
    <div class="scrim scrim-center">
      <div class="alert" role="alertdialog" aria-label={title}>
        <p class="body-strong">{title}</p>
        <p class="meta">{message}</p>
        <div class="alert-buttons">
          {/* Focused first, so Return can never confirm something destructive. */}
          <button autofocus onClick={onCancel}>{cancel}</button>
          {confirm && <button class="danger" onClick={onConfirm}>{confirm}</button>}
        </div>
      </div>
    </div>
  );
}
