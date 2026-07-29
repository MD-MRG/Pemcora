import Stub from '../components/Stub.jsx'

export default function Home() {
  return (
    <Stub
      title="Home"
      summary="The landing view — what needs attention today, without hunting for it."
      points={[
        'Sites with open faults, most urgent first',
        'Visits due in the next 30 days',
        'Recent activity across the team',
        'Quick entry into a job already in progress',
      ]}
      step="its own planning step"
    />
  )
}
