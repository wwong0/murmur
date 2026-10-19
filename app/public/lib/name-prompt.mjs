// Whether a page shows the "Choose a name" prompt: a plain invite link, once per tab
// (design.md D19). The raw parameters are read, not `readRoute`, whose role defaults to
// `viewer`: through it every role-less URL would look like an invite, and a rig URL
// (`?room=…&role=…&tab=…`) must never show the prompt.
export function namePromptDue(search, prompted) {
  const params = new URLSearchParams(search);
  // A room is what the page itself counts as one: `?room=` with no value is the front page.
  const plainInvite = Boolean(params.get('room')) && !params.has('role') && !params.has('tab');
  return plainInvite && prompted !== '1';
}
