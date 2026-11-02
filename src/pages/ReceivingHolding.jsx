// What a landlord or agency team sees on its own pages until they're built: Due in
// step C4, Properties and Reports in step D4. An empty menu would look broken, and
// these say what is coming and where it will land.
const PAGES = {
  properties: {
    title: 'Your properties will appear here',
    body: 'Each property your providers send reports for, with what is due there and the reports on file.',
  },
  reports: {
    title: 'Reports sent to you will appear here',
    body: 'Every report your providers send, ready to open and download.',
  },
  due: {
    title: 'What is coming due will appear here',
    body: 'Checks that are overdue or coming up across your properties, so nothing lapses.',
  },
}

export default function ReceivingHolding({ page }) {
  const { title, body } = PAGES[page]
  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <div className="border-hair rounded-xl border bg-card p-6">
        <h2 className="text-ink text-[16px] font-semibold">{title}</h2>
        <p className="text-ink-soft mt-2 text-[13.5px] leading-relaxed">{body}</p>
        <p className="text-ink-soft mt-2 text-[13.5px] leading-relaxed">
          This part of Pemcora is still being built.
        </p>
      </div>
    </div>
  )
}
