// Point this at your deployed Render backend URL, e.g.
// "https://fastcoach-backend.onrender.com/api"
// Left as a relative path by default so it also works if you
// ever serve frontend + backend from the same origin.
window.FASTCOACH_API_BASE =
  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:5000/api'
    : 'https://diet-2-59ro.onrender.com/api';