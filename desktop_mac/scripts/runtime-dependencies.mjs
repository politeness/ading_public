import {cp,mkdir,readFile,realpath} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';

async function resolvePackage(name,manifestPath) {
  const require=createRequire(manifestPath);
  let entry;
  try {entry=require.resolve(`${name}/package.json`);}
  catch {entry=require.resolve(name);}
  let directory=path.dirname(await realpath(entry));
  while(true) {
    try {const manifest=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'));if(manifest.name===name)return {directory,manifest};}
    catch(error) {if(error.code!=='ENOENT')throw error;}
    const parent=path.dirname(directory);if(parent===directory)throw new Error(`Cannot resolve runtime package ${name}`);directory=parent;
  }
}

/** Copy production dependencies into the standalone application, preserving nested resolution. */
export async function copyRuntimeDependencies(projectRoot,applicationRoot) {
  const manifestPath=path.join(projectRoot,'package.json');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  const copied=[];
  async function copy(name,parentManifest,targetRoot,ancestors=[]) {
    if(!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(name))throw new Error(`Invalid runtime package name: ${name}`);
    const resolved=await resolvePackage(name,parentManifest);
    if(ancestors.includes(resolved.directory))return;
    const target=path.join(targetRoot,name);
    await mkdir(path.dirname(target),{recursive:true});
    await cp(resolved.directory,target,{recursive:true,dereference:true,filter:source=>!path.relative(resolved.directory,source).split(path.sep).includes('node_modules')});
    copied.push({name,version:resolved.manifest.version,path:target});
    const sourceManifest=path.join(resolved.directory,'package.json');
    const optional=new Set(Object.keys(resolved.manifest.optionalDependencies??{}));
    for(const dependency of Object.keys({...resolved.manifest.dependencies,...resolved.manifest.optionalDependencies})) {
      if(optional.has(dependency)) {try {await resolvePackage(dependency,sourceManifest);}catch(error){if(error.code==='MODULE_NOT_FOUND')continue;throw error;}}
      await copy(dependency,sourceManifest,path.join(target,'node_modules'),[...ancestors,resolved.directory]);
    }
  }
  for(const name of Object.keys(manifest.dependencies??{}))await copy(name,manifestPath,path.join(applicationRoot,'node_modules'));
  return copied;
}
