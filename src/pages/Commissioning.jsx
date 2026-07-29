import Stub from '../components/Stub.jsx'

export default function Commissioning() {
  return (
    <Stub
      title="Commissioning"
      summary="Verifying a room at handover — device by device, with a record that stands up later."
      points={[
        'Per-room device checklist against your commissioning test list',
        'Firmware versions and signal verification captured at the time',
        'Faults raised with notes, carried into the report',
        'Sign-off, then export',
      ]}
      step="the Commissioning & Maintenance step, reusing the proven test-list and export code"
    />
  )
}
