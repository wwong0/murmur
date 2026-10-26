// What a roster event's kind does to the room's membership. Pure: the runner, the
// refusals and the figures all ask it, so none of them spells the list of kinds.

const LEAVE_KINDS = Object.freeze(['leave-clean', 'leave-silent', 'leave-first', 'leave-supplier-silent']);

/** The member is gone from the room after the event, and from the end boundary. */
export const removesMember = (kind) => LEAVE_KINDS.includes(kind);

/** The member is in one boundary only: a join adds it, a leave removes it. */
export const changesMembership = (kind) => kind === 'join' || removesMember(kind);
