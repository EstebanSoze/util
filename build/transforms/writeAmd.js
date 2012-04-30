define([
	"../buildControl",
	"../fileUtils",
	"../fs",
	"dojo/_base/lang",
	"dojo/json"
], function(bc, fileUtils, fs, lang, json){
	var
		setText = function(resource, text){
			if(!resource.setText){
				resource.setText = function(text){
					resource.text = text;
					resource.getText = function(){ return this.text; };
					return text;
				};
			}
			resource.setText(text);
			return text;
		},

		computingLayers
			// the set of layers being computed; use this to detect circular layer dependencies
			= {},

		computeLayerContents = function(
			layerModule,
			include,
			exclude
		){
			// add property layerSet (a set of mid) to layerModule that...
			//
			//	 * includes dependency tree of layerModule
			//	 * includes all modules in layerInclude and their dependency trees
			//	 * excludes all modules in layerExclude and their dependency trees
			//	 * excludes layerModule itself
			//
			// note: layerSet is built exactly as given above, so included modules that are later excluded
			// are *not* in result layerSet
			if(layerModule && computingLayers[layerModule.mid]){
				bc.log("amdCircularDependency", ["module", layerModule.mid]);
				return {};
			}
			computingLayers[layerModule.mid] = 1;

			var
				includeSet = {},
				visited,
				includePhase,
				traverse = function(module){
					var mid = module.mid;

					if(visited[mid]){
						return;
					}
					visited[mid] = 1;
					if(includePhase){
						includeSet[mid] = module;
					}else{
						delete includeSet[mid];
					}
					if(module!==layerModule && module.layer){
						var layerModuleSet = module.moduleSet || computeLayerContents(module, module.layer.include, module.layer.exclude);
						for(var p in layerModuleSet){
							if(includePhase){
								includeSet[p] = layerModuleSet[p];
							}else{
								delete includeSet[p];
							}
						}
					}else{
						for(var deps = module.deps, i = 0; deps && i<deps.length; traverse(deps[i++])){
						}
					}
				};

			visited = {};
			includePhase = true;
			if(layerModule){
				traverse(layerModule);
			}
			include.forEach(function(mid){
				var module = bc.amdResources[bc.getSrcModuleInfo(mid, layerModule).mid];
				if(!module){
					bc.log("amdMissingLayerIncludeModule", ["missing", mid, "layer", layerModule && layerModule.mid]);
				}else{
					traverse(module);
				}
			});

			visited = {};
			includePhase = false;
			exclude.forEach(function(mid){
				var module = bc.amdResources[bc.getSrcModuleInfo(mid, layerModule).mid];
				if(!module){
					bc.log("amdMissingLayerExcludeModule", ["missing", mid, "layer", layerModule && layerModule.mid]);
				}else{
					traverse(module);
				}
			});

			if(layerModule){
				layerModule.moduleSet = includeSet;
				delete computingLayers[layerModule.mid];
			}
			return includeSet;
		},

		insertAbsMid = function(
			text,
			resource
		){
			return (!resource.mid || resource.tag.hasAbsMid || !bc.insertAbsMids) ?
				text : text.replace(/(define\s*\(\s*)(.*)/, "$1\"" + resource.mid + "\", $2");
		},

		getCacheEntry = function(
			pair
		){
			return "'" + pair[0] + "':" + pair[1];
		},

		getPreloadL10nRootPath = function(
			dest
		){
			var match = dest.match(/(.+)\/([^\/]+)$/);
			return match[1] + "/nls/" + match[2];
		},

		flattenRootBundle = function(
			resource
		){
			if(resource.flattenedBundles){
				return;
			}
			resource.flattenedBundles = {};
			bc.localeList.forEach(function(locale){
				var accumulator = lang.mixin({}, resource.bundleValue.root);
				bc.localeList.discreteLocales[locale].forEach(function(discreteLocale){
					var localizedBundle = resource.localizedSet[discreteLocale];
					if(localizedBundle && localizedBundle.bundleValue){
						lang.mixin(accumulator, localizedBundle.bundleValue);
					}
				});
				resource.flattenedBundles[locale] = accumulator;
			});
		},

		getFlattenedBundles = function(
			resource,
			rootBundles
		){
			rootBundles.forEach(flattenRootBundle);

			var newline = bc.newline,
				rootPath = getPreloadL10nRootPath(resource.dest.match(/(.+)(\.js)$/)[1]),
				mid, cache;
			bc.localeList.forEach(function(locale){
				cache = [];
				rootBundles.forEach(function(rootResource){
					cache.push("'" + rootResource.prefix + rootResource.bundle + "':" + json.stringify(rootResource.flattenedBundles[locale]) + newline);
				});
				mid = getPreloadL10nRootPath(resource.mid) + "_" + locale;
				var flattenedResource = {
					src:"*synthetic*",
					dest:rootPath + "_" + locale + ".js",
					pid:resource.pid,
					mid:mid,
					pack:resource.pack,
					deps:[],
					tag:{flattenedNlsBundle:1},
					encoding:'utf8',
					text:"define(" + (bc.insertAbsMids ? "'" + mid + "',{" : "{") + newline + cache.join("," + newline) + "});",
					getText:function(){ return this.text; }
				};
				if(bc.insertAbsMids){
					flattenedResource.tag.hasAbsMid = 1;
				}
				bc.start(flattenedResource);
			});
		},

		getLayerText = function(
			resource,
			resourceText
		){
			var newline = bc.newline,
				rootBundles = [],
				cache = [],
				moduleSet = computeLayerContents(resource, resource.layer.include, resource.layer.exclude);
			for(var p in moduleSet) if(p!=resource.mid){
				var module = moduleSet[p];
				if(module.localizedSet && bc.localeList){
					// this is a root NLS bundle and the profile is building flattened layer bundles;
					// therefore, add this bundle to the set to be flattened, but don't write the root bundle
					// to the cache since the loader will explicitly load the flattened bundle
					rootBundles.push(module);
				}else if(module.internStrings){
					cache.push(getCacheEntry(module.internStrings()));
				}else if(module.getText){
					cache.push("'" + p + "':function(){" + newline + module.getText() + newline + "}");
				}else{
					bc.log("amdMissingLayerModuleText", ["module", module.mid, "layer", resource.mid]);
				}
			}

			// compute the flattened layer bundles (if any)
			if(rootBundles.length){
				getFlattenedBundles(resource, rootBundles);
				// push an *now into the cache that causes the flattened layer bundles to be loaded immediately
				cache.push("'*now':function(r){r(['dojo/i18n!*preload*" + getPreloadL10nRootPath(resource.mid) + "*" + json.stringify(bc.localeList) + "']);}" + newline);
			}

			// construct the cache text
			if(cache.length && resource.layer.noref){
				cache.push("'*noref':1");
			}

			return	(cache.length ? "require({cache:{" + newline + cache.join("," + newline) + "}});" + newline : "") +
				(resourceText===undefined ?	 insertAbsMid(resource.getText(), resource) : resourceText) +
				(resource.layer.postscript ? resource.layer.postscript : "");
		},

		getStrings = function(
			resource
		){
			var cache = [],
				newline = bc.newline;
			resource.deps && resource.deps.forEach(function(dep){
				if(dep.internStrings){
					cache.push(getCacheEntry(dep.internStrings()));
				}
			});
			return cache.length ? "require({cache:{" + newline + cache.join("," + newline) + "}});" + newline : "";
		},

		getDestFilename = function(
			resource
		){
			if((resource.layer && bc.layerOptimize) || (!resource.layer && bc.optimize)){
				return resource.dest + ".uncompressed.js";
			}
			return resource.dest;
		},

		convertLegacyBundle = function(
			resource
		){
			var newline = bc.newline, p;
			if(bc.localeList){
				if(resource.localizedSet){
					for(p in resource.localizedSet){
						resource.bundleValue[p] = 1;
					}
				}
				return setText(resource, "define(" + newline + json.stringify(this.bundleValue) + newline + ");" + newline);
			}else{
				var text = resource.getText();

				// this is from the old builder; apparently bundles were improperly written with trailing semicolons sometimes
				text = text.replace(/;\s*$/, "");

				if(resource.localizedSet){
					// this is the root bundle
					var availableLocales = [];
					for(p in resource.localizedSet){
						availableLocales.push("\"" + p + "\":1");
					}
					text = "define({root:" + newline + text + "," + newline + availableLocales.join("," + newline) + "}" + newline + ");" + newline;
				}else{
					text = "define(" + newline + text + newline + ");";
				}
				return setText(resource, text);
			};
		},


		write = function(
			resource,
			callback
		){
			if(resource.layer && (resource.layer.boot || resource.layer.discard)){
				// resource.layer.boot layers are written by the writeDojo transform
				return 0;
			}

			var copyright;
			if(resource.pack){
				copyright = resource.pack.copyrightNonlayers && (resource.pack.copyright || bc.copyright);
			}else{
				copyright = bc.copyrightNonlayers &&  bc.copyright;
			}
			if(!copyright){
				copyright = "";
			}

			var text;
			if(resource.tag.nls){
				text = insertAbsMid(resource.getText(), resource);
			}else if(resource.layer){
				// don't insertAbsMid or internStrings since that's done in getLayerText
				text= resource.layerText = getLayerText(resource);
				if(resource.layer.compat=="1.6"){
					text = resource.layerText= text + "require(" + json.stringify(resource.layer.include) + ");" + bc.newline;
				}
				copyright = resource.layer.copyright || "";
			}else{
				text = insertAbsMid(resource.getText(), resource);
				text = (bc.internStrings ? getStrings(resource) : "") + text;
			}

			setText(resource, text);
			var destFilename = getDestFilename(resource);
			fileUtils.ensureDirectoryByFilename(destFilename);
			fs.writeFile(destFilename, bc.newlineFilter(resource.getText(), resource, "writeAmd"), resource.encoding, function(err){
				callback(resource, err);
			});
			return callback;
		};

		write.getLayerText = getLayerText;
		write.getDestFilename = getDestFilename;
		write.computeLayerContents = computeLayerContents;

		return write;
});

