import Stub from '../components/Stub.jsx'

export default function PreventativeMaintenance() {
  return (
    <Stub
      title="Preventative Maintenance"
      summary="A scheduled visit, worked room by room, ending in the report the client receives."
      points={[
        'One page per room: PASS / FAIL / N/A against your maintenance test list',
        'Troubleshooting notes required wherever a test fails',
        'Results locked to the test list as it stood on the day',
        'Excel export, with formatting preserved',
      ]}
      step="the Commissioning & Maintenance step, reusing the proven test-list and export code"
    />
  )
}
