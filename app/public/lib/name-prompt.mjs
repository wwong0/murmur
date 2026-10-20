// Whether the "Choose a name" prompt is due, once per tab (design.md D19). Read the raw
// parameters, not `readRoute`: its role defaults to `viewer`, so a rig URL would read as an
// invite. An empty `?room=` is the front page.
export function namePromptDue(search, prompted, fromFront = false) {
  const params = new URLSearchParams(search);
  const plainInvite = Boolean(params.get('room')) && !params.has('role') && !params.has('tab');
  return (fromFront === true || plainInvite) && prompted !== '1';
}
