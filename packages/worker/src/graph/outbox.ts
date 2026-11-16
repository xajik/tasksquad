import type { Env } from '../types.js'
import { graph,rows,snapshot,sql,type Data } from './store.js'

export async function materialize(env:Env,graphId:string):Promise<void>{
 const g=await graph(env.DB,graphId),now=Date.now()
 const pending=await rows<{id:number;kind:string;graph_version:number}>(env.DB,"SELECT id,kind,graph_version FROM graph_outbox WHERE graph_id=? AND status='pending' AND available_at<=? ORDER BY graph_version DESC LIMIT 10",g.id,now)
 for(const item of pending){
  if(item.graph_version!==g.version){await sql(env.DB,"UPDATE graph_outbox SET status='superseded' WHERE id=?",item.id).run();continue}
  try{
   const data=await snapshot(env.DB,g)
   if(item.kind==='snapshot')await env.LOGS.put(`graphs/${g.team_id}/${g.id}/snapshots/${g.version}.json`,JSON.stringify(data),{httpMetadata:{contentType:'application/json'}})
   else{
    if(!env.GRAPH_AI||!env.GRAPH_VECTORS)continue
    const entities:Data[]=[...(data.nodes as Data[]).map(n=>({...n,visibility:n.kind==='goal'||n.kind==='milestone'?'private':'execution'})),...(data.resources as Data[])]
    for(const entity of entities){
     const output=await env.GRAPH_AI.run('@cf/baai/bge-base-en-v1.5',{text:[[entity.title,entity.description,entity.body].join('\n')]}) as {data:number[][]}
     await env.GRAPH_VECTORS.upsert([{id:`${entity.id}:${g.version}`,values:output.data[0],namespace:g.team_id,metadata:{graph_id:g.id,version:g.version,visibility:String(entity.visibility),entity_id:String(entity.id)}}])
    }
   }
   await sql(env.DB,"UPDATE graph_outbox SET status='done',error=NULL WHERE id=?",item.id).run()
  }catch(e){await sql(env.DB,'UPDATE graph_outbox SET attempts=attempts+1,error=?,available_at=? WHERE id=?',String(e),now+60_000,item.id).run()}
 }
}
