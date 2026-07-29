import Stub from '../components/Stub.jsx'

export default function NewClient() {
  return (
    <Stub
      title="New Client"
      summary="Create a client record once, then reuse it for every commissioning and maintenance job."
      points={[
        'Company details and billing reference',
        'One or more sites, each with an address',
        'Rooms held against a site, so jobs can be pre-populated',
        'Contacts, with who signs off on site',
      ]}
      step="its own planning step"
    />
  )
}
