import {existsSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
export function sourceMetadata(root){
  if(existsSync(path.join(root,'.git'))){
    const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
    return {commit:git(['rev-parse','HEAD']),dirty:Boolean(git(['status','--porcelain'])),updated:git(['log','-1','--format=%cs','--','program/program-manual.md'])};
  }
  const source=JSON.parse(readFileSync(path.join(root,'SOURCE.json'),'utf8'));
  return {commit:'exported-from-'+source.revision,dirty:true,updated:source.date};
}
