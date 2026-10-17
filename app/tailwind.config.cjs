// Tailwind v3 for the room page (design.md D1). Preflight is off so the page's own
// CSS, moved verbatim into styles/room.css, keeps the geometry the drivers click by.
module.exports = {
  content: ['./public/room.html', './public/room/**/*.jsx'],
  corePlugins: { preflight: false },
};
