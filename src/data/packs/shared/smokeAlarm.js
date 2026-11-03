// A smoke alarm test whose failure means the alarm itself is at fault, so it has
// to be replaced (M.D.'s note in step B2): the wrong kind of alarm, too old, or
// not working. The report prints that beside the reason it failed.
//
// Every other test on an alarm fails with an ordinary note, because something
// else fixes it: reinstalling or moving the alarm, a new battery, interconnecting
// it, or cleaning it.
export const replaceOnFail = label => ({ label, onFail: 'replace' })
