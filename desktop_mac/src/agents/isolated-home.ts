import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readlink, rename, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface IsolatedHome {
  /** Pass this as the vendor's home directory for the turn. */
  path:string;
  /** Run after the turn: a credential the vendor rewrote in place of its link goes back to the real home. */
  settle:()=>Promise<void>;
}

/**
 * Some vendors have no switch for their user-level rules and memory, only for where their home is.
 * This mirrors the real home with one symlink per entry, leaving out what must not be read, so login,
 * configuration and session storage stay the real ones and resuming a session keeps working.
 */
export async function isolatedHome(kind:string,realHome:string,hidden:(name:string)=>boolean,credentials:string[]=[],scope=""):Promise<IsolatedHome> {
  const key=createHash("sha256").update(JSON.stringify([realHome,scope])).digest("hex").slice(0,12);
  const home=path.join(os.tmpdir(),`ading-isolated-${os.userInfo().uid}`,`${kind}-${key}`);
  await mkdir(home,{recursive:true,mode:0o700});
  const settle=async():Promise<void>=>{
    for(const name of credentials) {
      const link=path.join(home,name);
      const entry=await lstat(link).catch(()=>undefined);
      if(!entry?.isFile())continue;
      const candidate=`${path.join(realHome,name)}.ading-${process.pid}`;
      await copyFile(link,candidate);
      await rename(candidate,path.join(realHome,name));
      await rm(link,{force:true});
      await symlink(path.join(realHome,name),link);
    }
  };
  await settle();
  const real=await readdir(realHome).catch(()=>[] as string[]);
  const wanted=new Set(real.filter(name=>!hidden(name)));
  for(const name of await readdir(home)) {
    const entry=await lstat(path.join(home,name)).catch(()=>undefined);
    // The vendor's own new files stay; only a link that no longer applies goes.
    if(entry?.isSymbolicLink()&&!wanted.has(name))await rm(path.join(home,name),{force:true});
  }
  await Promise.all([...wanted].map(async name=>{
    const link=path.join(home,name),target=path.join(realHome,name);
    if(await readlink(link).catch(()=>undefined)===target)return;
    // Parallel lanes refresh the same directory: whoever links first wins.
    await symlink(target,link).catch(error=>{if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;});
  }));
  return {path:home,settle};
}
