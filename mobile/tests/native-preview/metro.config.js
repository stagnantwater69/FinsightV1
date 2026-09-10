const path = require('node:path');
const {getDefaultConfig}=require('expo/metro-config');
const mobile=path.resolve(__dirname,'../..');
const config=getDefaultConfig(__dirname);
config.watchFolders=[mobile];
config.resolver.nodeModulesPaths=[path.join(mobile,'node_modules')];
config.resolver.resolveRequest=(context,name,platform)=>{
 if(name.endsWith('/lib/api') && context.originModulePath.startsWith(path.join(mobile,'src'))) return {filePath:path.join(__dirname,'api.js'),type:'sourceFile'};
 return context.resolveRequest(context,name,platform);
};
module.exports=config;
