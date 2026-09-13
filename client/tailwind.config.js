/** @type {import('tailwindcss').Config} */
export default {
  content:["./index.html","./src/**/*.{ts,tsx}"],
  theme:{extend:{fontFamily:{sans:["Inter","ui-sans-serif","system-ui"]},boxShadow:{soft:"0 18px 50px rgba(15,23,42,.08)"}}},
  plugins:[]
}
