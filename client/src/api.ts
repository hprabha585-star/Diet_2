const API=import.meta.env.VITE_API_URL || "http://localhost:5000/api";
export async function api(path:string, options:RequestInit={}) {
  const token=localStorage.getItem("fc_token");
  const headers=new Headers(options.headers);
  if(!(options.body instanceof FormData)) headers.set("Content-Type","application/json");
  if(token) headers.set("Authorization",`Bearer ${token}`);
  const res=await fetch(`${API}${path}`,{...options,headers});
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.message||"Request failed");
  return data;
}
export {API};
