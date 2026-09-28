import {hashBlob} from './file-hash';
self.onmessage=async({data})=>{try{
  if(data.mode==='chunk'){
    const bytes=await data.file.arrayBuffer();
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    self.postMessage({hash:Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('')});
  }else{
    const hash=await hashBlob(data.file,bytes=>self.postMessage({bytes}));
    self.postMessage({hash});
  }
}catch(error){self.postMessage({error:String(error.message)});}};
