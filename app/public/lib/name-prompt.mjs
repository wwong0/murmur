// Whether a page shows the "Choose a name" prompt, once per tab (design.md D19, as the
// owner's 5.5 answer amends it): on a plain invite link, and on a room this document
// reached from its own front route (`fromFront` — pressing Host keeps the document and
// its rig-style URL). The raw parameters are read, not `readRoute`, whose role defaults to
// `viewer`: through it every role-less URL would look like an invite, and a rig URL
// (`?room=…&role=…&tab=…`) opened directly must never show the prompt.
export function namePromptDue(search, prompted, fromFront = false) {
  const params = new URLSearchParams(search);
  // A room is what the page itself counts as one: `?room=` with no value is the front page.
  const plainInvite = Boolean(params.get('room')) && !params.has('role') && !params.has('tab');
  return (fromFront === true || plainInvite) && prompted !== '1';
}
