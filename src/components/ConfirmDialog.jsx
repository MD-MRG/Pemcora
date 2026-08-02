// In-app confirmation.
//
// Deliberately not window.confirm: native dialogs are auto-dismissed in
// embedded webviews (including the preview pane), which makes confirm() return
// false and the action silently do nothing. They also can't be styled and get
// throttled when repeated.
export default function ConfirmDialog({
  title,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onCancel}
    >
      <div
        className="border-hair w-full max-w-md rounded-xl border bg-white p-5 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-[16px] font-bold">{title}</h2>
        {children && <div className="text-ink-soft mt-2 text-[13.5px]">{children}</div>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="border-hair text-ink min-h-[46px] rounded-lg border px-4 text-[13.5px] font-semibold hover:bg-slate-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            autoFocus
            onClick={onConfirm}
            className={`min-h-[46px] rounded-lg px-5 text-[13.5px] font-semibold text-white ${
              danger ? 'bg-fail hover:bg-[#a52717]' : 'bg-navy hover:bg-[#24486e]'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
