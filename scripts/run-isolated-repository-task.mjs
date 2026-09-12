import { loadConfig } from "../src/config.mjs";
import { openDatabase } from "../src/db.mjs";
import { Repository } from "../src/repository.mjs";

const [task,databasePath,entityId]=process.argv.slice(2);
const supported=new Set(["rebuild_knowledge","rebuild_topic_clusters","build_coverage_matrix","rebuild_content_opportunities"]);
if(!supported.has(task)||!databasePath||!entityId)throw new Error("Usage: run-isolated-repository-task <task> <database-path> <entity-id>");
const config=loadConfig();
const database=openDatabase(databasePath);
try{
  const repository=new Repository(database,{...config.content,...config.extraction,sourceUploadsDir:config.manualSources.uploadDir});
  let result;
  if(task==="rebuild_knowledge")result=repository.rebuildKnowledge(entityId);
  else if(task==="rebuild_topic_clusters")result={updated:repository.rebuildTopicClusters(entityId)};
  else if(task==="rebuild_content_opportunities")result=repository.rebuildKnowledgeOpportunities(entityId);
  else{
    const dirty=repository.takeCoverageDirty(entityId);
    try{
      const updated=repository.rebuildCoverageMatrices(entityId,{changedFactKeys:dirty?.changedFactKeys||null});
      if(dirty)repository.completeCoverageDirty(entityId);
      result={updated,...repository.lastCoverageRebuildTelemetry};
    }catch(error){if(dirty)repository.completeCoverageDirty(entityId,{failed:true});throw error;}
  }
  process.stdout.write(`${JSON.stringify({ok:true,task,entityId,result})}\n`);
}finally{database.close();}
