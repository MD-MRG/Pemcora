// Core — what every team has, whatever else it does.

export default {
  id: 'core',
  label: 'Core',
  workflows: [
    {
      // A one-off list the technician builds themselves. It seeds nothing — a
      // job starts with an empty main section and the technician adds named
      // sections as needed.
      id: 'custom',
      label: 'Custom list',
      nav: {
        key: 'custom-list',
        path: '/custom-list',
        label: 'Custom List',
        blurb: 'Build a one-off checklist from your own test items',
        icon: 'list',
      },
      page: {
        title: 'Custom List',
        progressNoun: 'Custom list',
        startLabel: 'Start custom list',
        newLabel: 'Start new custom list',
        emptyLine: 'No custom list recorded for this location',
        reportTitle: 'Custom List',
      },
      seed: { main: [], sections: [] },
    },
  ],
}
