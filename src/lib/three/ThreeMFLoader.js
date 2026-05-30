// @ts-nocheck — vendored third-party loader; not type-checked.
import {
	BufferAttribute,
	BufferGeometry,
	ClampToEdgeWrapping,
	Color,
	FileLoader,
	Float32BufferAttribute,
	Group,
	LinearFilter,
	LinearMipmapLinearFilter,
	Loader,
	Matrix4,
	Mesh,
	MeshPhongMaterial,
	MeshStandardMaterial,
	MirroredRepeatWrapping,
	NearestFilter,
	RepeatWrapping,
	TextureLoader,
	SRGBColorSpace
} from 'three';
import * as fflate from 'three/examples/jsm/libs/fflate.module.js';
import { decodePaintedTriangle } from './paint3mf';

const COLOR_SPACE_3MF = SRGBColorSpace;

// VENDORED from three/examples/jsm/loaders/3MFLoader.js and patched to support
// the 3MF Production Extension (multi-part .model files referenced by p:path).
// Bambu Studio, OrcaSlicer, and PrusaSlicer all split mesh objects into separate
// 3D/Objects/*.model parts; stock ThreeMFLoader flattens objects by id and ignores
// p:path, so a build item/component that points into another part resolves to
// undefined and throws. Patched sites are marked with `// PATCH:`. Re-apply these
// on three.js upgrades.

/**
 *
 * 3D Manufacturing Format (3MF) specification: https://3mf.io/specification/
 *
 * The following features from the core specification are supported:
 *
 * - 3D Models
 * - Object Resources (Meshes and Components)
 * - Material Resources (Base Materials)
 *
 * 3MF Materials and Properties Extension are only partially supported.
 *
 * - Texture 2D
 * - Texture 2D Groups
 * - Color Groups (Vertex Colors)
 * - Metallic Display Properties (PBR)
 */

class ThreeMFLoader extends Loader {

	constructor( manager ) {

		super( manager );

		this.availableExtensions = [];

	}

	load( url, onLoad, onProgress, onError ) {

		const scope = this;
		const loader = new FileLoader( scope.manager );
		loader.setPath( scope.path );
		loader.setResponseType( 'arraybuffer' );
		loader.setRequestHeader( scope.requestHeader );
		loader.setWithCredentials( scope.withCredentials );
		loader.load( url, function ( buffer ) {

			try {

				onLoad( scope.parse( buffer ) );

			} catch ( e ) {

				if ( onError ) {

					onError( e );

				} else {

					console.error( e );

				}

				scope.manager.itemError( url );

			}

		}, onProgress, onError );

	}

	parse( data ) {

		const scope = this;
		const textureLoader = new TextureLoader( this.manager );

		// PATCH: maps a normalized model-part path (e.g. "3D/Objects/object_24.model")
		// to its parsed modelData, so component/build-item references that carry a
		// p:path can be resolved against the correct part. Populated in buildObjects().
		let modelsByPath = {};

		// PATCH: multicolor support. Slicers (Bambu/Orca via `paint_color`, Prusa via
		// `slic3rpe:mmu_segmentation`) store per-triangle paint state plus a global
		// filament/extruder palette in a Metadata/*.config file. We extract the palette
		// here and, when a mesh carries paint codes, build a vertex-colored mesh from the
		// decoded sub-triangles instead of a single flat-colored mesh. documentPalette is
		// a flat Float32Array of linear RGB triplets (index 0 == filament/extruder 1).
		let documentPalette = null; // Float32Array | null
		let documentBaseColor = [ 0.74, 0.58, 0.98 ]; // fallback Dracula purple (linear-ish)

		// PATCH: parse the filament/extruder color palette from the zip's metadata.
		function parsePalette( zip, textDecoder ) {

			const colorObject = new Color();
			const toLinearTriplets = ( hexes ) => {

				const out = [];
				for ( let i = 0; i < hexes.length; i ++ ) {

					const hex = String( hexes[ i ] ).trim().substring( 0, 7 );
					if ( hex.length < 7 ) continue;
					colorObject.setStyle( hex, COLOR_SPACE_3MF );
					out.push( colorObject.r, colorObject.g, colorObject.b );

				}

				return out.length ? new Float32Array( out ) : null;

			};

			// Bambu Studio / OrcaSlicer: JSON project settings with a filament_colour array.
			if ( zip[ 'Metadata/project_settings.config' ] ) {

				try {

					const json = JSON.parse( textDecoder.decode( zip[ 'Metadata/project_settings.config' ] ) );
					if ( Array.isArray( json.filament_colour ) ) return toLinearTriplets( json.filament_colour );

				} catch ( e ) { /* fall through */ }

			}

			// PrusaSlicer: INI-style config; prefer extruder_colour (distinct per extruder),
			// fall back to filament_colour. Values are ';'-separated and lines may be
			// comment-prefixed ("; key = ...").
			if ( zip[ 'Metadata/Slic3r_PE.config' ] ) {

				const text = textDecoder.decode( zip[ 'Metadata/Slic3r_PE.config' ] );
				const readKey = ( key ) => {

					const m = text.match( new RegExp( '^[;\\s]*' + key + '\\s*=\\s*(.+)$', 'm' ) );
					if ( ! m ) return null;
					const parts = m[ 1 ].split( ';' ).map( ( s ) => s.trim() ).filter( ( s ) => s.length );
					return parts.length ? parts : null;

				};

				const colours = readKey( 'extruder_colour' ) || readKey( 'filament_colour' );
				if ( colours ) return toLinearTriplets( colours );

			}

			return null;

		}

		// PATCH: normalize a p:path attribute (absolute, leading "/") to the keys used
		// by the zip/modelParts map (no leading "/"). Falls back to the current part.
		function resolvePartPath( path, currentPath ) {

			if ( ! path ) return currentPath;
			return path.charAt( 0 ) === '/' ? path.substring( 1 ) : path;

		}

		function loadDocument( data ) {

			let zip = null;
			let file = null;

			let relsName;
			let modelRelsName;
			const modelPartNames = [];
			const texturesPartNames = [];

			let modelRels;
			const modelParts = {};
			const printTicketParts = {};
			const texturesParts = {};

			const textDecoder = new TextDecoder();

			try {

				zip = fflate.unzipSync( new Uint8Array( data ) );

			} catch ( e ) {

				if ( e instanceof ReferenceError ) {

					console.error( 'THREE.3MFLoader: fflate missing and file is compressed.' );
					return null;

				}

			}

			for ( file in zip ) {

				if ( file.match( /\_rels\/.rels$/ ) ) {

					relsName = file;

				} else if ( file.match( /3D\/_rels\/.*\.model\.rels$/ ) ) {

					modelRelsName = file;

				} else if ( file.match( /^3D\/.*\.model$/ ) ) {

					modelPartNames.push( file );

				} else if ( file.match( /^3D\/Textures?\/.*/ ) ) {

					texturesPartNames.push( file );

				}

			}

			if ( relsName === undefined ) throw new Error( 'THREE.ThreeMFLoader: Cannot find relationship file `rels` in 3MF archive.' );

			//

			const relsView = zip[ relsName ];
			const relsFileText = textDecoder.decode( relsView );
			const rels = parseRelsXml( relsFileText );

			//

			if ( modelRelsName ) {

				const relsView = zip[ modelRelsName ];
				const relsFileText = textDecoder.decode( relsView );
				modelRels = parseRelsXml( relsFileText );

			}

			//

			for ( let i = 0; i < modelPartNames.length; i ++ ) {

				const modelPart = modelPartNames[ i ];
				const view = zip[ modelPart ];

				const fileText = textDecoder.decode( view );
				const xmlData = new DOMParser().parseFromString( fileText, 'application/xml' );

				if ( xmlData.documentElement.nodeName.toLowerCase() !== 'model' ) {

					console.error( 'THREE.3MFLoader: Error loading 3MF - no 3MF document found: ', modelPart );

				}

				const modelNode = xmlData.querySelector( 'model' );
				const extensions = {};

				for ( let i = 0; i < modelNode.attributes.length; i ++ ) {

					const attr = modelNode.attributes[ i ];
					if ( attr.name.match( /^xmlns:(.+)$/ ) ) {

						extensions[ attr.value ] = RegExp.$1;

					}

				}

				const modelData = parseModelNode( modelNode );
				modelData[ 'xml' ] = modelNode;

				if ( 0 < Object.keys( extensions ).length ) {

					modelData[ 'extensions' ] = extensions;

				}

				modelParts[ modelPart ] = modelData;

			}

			//

			for ( let i = 0; i < texturesPartNames.length; i ++ ) {

				const texturesPartName = texturesPartNames[ i ];
				texturesParts[ texturesPartName ] = zip[ texturesPartName ].buffer;

			}

			// PATCH: extract the filament/extruder palette once per document.
			documentPalette = parsePalette( zip, textDecoder );
			if ( documentPalette && documentPalette.length >= 3 ) {

				documentBaseColor = [ documentPalette[ 0 ], documentPalette[ 1 ], documentPalette[ 2 ] ];

			}

			return {
				rels: rels,
				modelRels: modelRels,
				model: modelParts,
				printTicket: printTicketParts,
				texture: texturesParts
			};

		}

		function parseRelsXml( relsFileText ) {

			const relationships = [];

			const relsXmlData = new DOMParser().parseFromString( relsFileText, 'application/xml' );

			const relsNodes = relsXmlData.querySelectorAll( 'Relationship' );

			for ( let i = 0; i < relsNodes.length; i ++ ) {

				const relsNode = relsNodes[ i ];

				const relationship = {
					target: relsNode.getAttribute( 'Target' ), //required
					id: relsNode.getAttribute( 'Id' ), //required
					type: relsNode.getAttribute( 'Type' ) //required
				};

				relationships.push( relationship );

			}

			return relationships;

		}

		function parseMetadataNodes( metadataNodes ) {

			const metadataData = {};

			for ( let i = 0; i < metadataNodes.length; i ++ ) {

				const metadataNode = metadataNodes[ i ];
				const name = metadataNode.getAttribute( 'name' );
				const validNames = [
					'Title',
					'Designer',
					'Description',
					'Copyright',
					'LicenseTerms',
					'Rating',
					'CreationDate',
					'ModificationDate'
				];

				if ( 0 <= validNames.indexOf( name ) ) {

					metadataData[ name ] = metadataNode.textContent;

				}

			}

			return metadataData;

		}

		function parseBasematerialsNode( basematerialsNode ) {

			const basematerialsData = {
				id: basematerialsNode.getAttribute( 'id' ), // required
				basematerials: []
			};

			const basematerialNodes = basematerialsNode.querySelectorAll( 'base' );

			for ( let i = 0; i < basematerialNodes.length; i ++ ) {

				const basematerialNode = basematerialNodes[ i ];
				const basematerialData = parseBasematerialNode( basematerialNode );
				basematerialData.index = i; // the order and count of the material nodes form an implicit 0-based index
				basematerialsData.basematerials.push( basematerialData );

			}

			return basematerialsData;

		}

		function parseTexture2DNode( texture2DNode ) {

			const texture2dData = {
				id: texture2DNode.getAttribute( 'id' ), // required
				path: texture2DNode.getAttribute( 'path' ), // required
				contenttype: texture2DNode.getAttribute( 'contenttype' ), // required
				tilestyleu: texture2DNode.getAttribute( 'tilestyleu' ),
				tilestylev: texture2DNode.getAttribute( 'tilestylev' ),
				filter: texture2DNode.getAttribute( 'filter' ),
			};

			return texture2dData;

		}

		function parseTextures2DGroupNode( texture2DGroupNode ) {

			const texture2DGroupData = {
				id: texture2DGroupNode.getAttribute( 'id' ), // required
				texid: texture2DGroupNode.getAttribute( 'texid' ), // required
				displaypropertiesid: texture2DGroupNode.getAttribute( 'displaypropertiesid' )
			};

			const tex2coordNodes = texture2DGroupNode.querySelectorAll( 'tex2coord' );

			const uvs = [];

			for ( let i = 0; i < tex2coordNodes.length; i ++ ) {

				const tex2coordNode = tex2coordNodes[ i ];
				const u = tex2coordNode.getAttribute( 'u' );
				const v = tex2coordNode.getAttribute( 'v' );

				uvs.push( parseFloat( u ), parseFloat( v ) );

			}

			texture2DGroupData[ 'uvs' ] = new Float32Array( uvs );

			return texture2DGroupData;

		}

		function parseColorGroupNode( colorGroupNode ) {

			const colorGroupData = {
				id: colorGroupNode.getAttribute( 'id' ), // required
				displaypropertiesid: colorGroupNode.getAttribute( 'displaypropertiesid' )
			};

			const colorNodes = colorGroupNode.querySelectorAll( 'color' );

			const colors = [];
			const colorObject = new Color();

			for ( let i = 0; i < colorNodes.length; i ++ ) {

				const colorNode = colorNodes[ i ];
				const color = colorNode.getAttribute( 'color' );

				colorObject.setStyle( color.substring( 0, 7 ), COLOR_SPACE_3MF );

				colors.push( colorObject.r, colorObject.g, colorObject.b );

			}

			colorGroupData[ 'colors' ] = new Float32Array( colors );

			return colorGroupData;

		}

		function parseImplicitIONode( implicitIONode ) {

			const portNodes = implicitIONode.children;
			const portArguments = {};
			for ( let i = 0; i < portNodes.length; i ++ ) {

				const args = { type: portNodes[ i ].nodeName.substring( 2 ) };
				for ( let j = 0; j < portNodes[ i ].attributes.length; j ++ ) {

					const attrib = portNodes[ i ].attributes[ j ];
					if ( attrib.specified ) {
		 				args[ attrib.name ] = attrib.value;
					}
				}

				portArguments[ portNodes[ i ].getAttribute( 'identifier' ) ] = args;

			}

			return portArguments;

		}

		function parseImplicitFunctionNode( implicitFunctionNode ) {

			const implicitFunctionData = {
				id: implicitFunctionNode.getAttribute( 'id' ),
				displayname: implicitFunctionNode.getAttribute( 'displayname' )
			};

			const functionNodes = implicitFunctionNode.children;

			const operations = {};

			for ( let i = 0; i < functionNodes.length; i ++ ) {

				const operatorNode = functionNodes[ i ];

				if ( operatorNode.nodeName === 'i:in' || operatorNode.nodeName === 'i:out' ) {

					operations[ operatorNode.nodeName === 'i:in' ? "inputs" : "outputs" ] = parseImplicitIONode( operatorNode );

				} else {

					const inputNodes = operatorNode.children;
					let portArguments = { "op": operatorNode.nodeName.substring( 2 ), "identifier": operatorNode.getAttribute( 'identifier' ) };
					for ( let i = 0; i < inputNodes.length; i ++ ) {

						portArguments[ inputNodes[ i ].nodeName.substring( 2 ) ] = parseImplicitIONode( inputNodes[ i ] );

					}

					operations[ portArguments[ "identifier" ] ] = portArguments;

				}

			}

			implicitFunctionData[ 'operations' ] = operations;

			return implicitFunctionData;

		}

		function parseMetallicDisplaypropertiesNode( metallicDisplaypropetiesNode ) {

			const metallicDisplaypropertiesData = {
				id: metallicDisplaypropetiesNode.getAttribute( 'id' ) // required
			};

			const metallicNodes = metallicDisplaypropetiesNode.querySelectorAll( 'pbmetallic' );

			const metallicData = [];

			for ( let i = 0; i < metallicNodes.length; i ++ ) {

				const metallicNode = metallicNodes[ i ];

				metallicData.push( {
					name: metallicNode.getAttribute( 'name' ), // required
					metallicness: parseFloat( metallicNode.getAttribute( 'metallicness' ) ), // required
					roughness: parseFloat( metallicNode.getAttribute( 'roughness' ) ) // required
				} );

			}

			metallicDisplaypropertiesData.data = metallicData;

			return metallicDisplaypropertiesData;

		}

		function parseBasematerialNode( basematerialNode ) {

			const basematerialData = {};

			basematerialData[ 'name' ] = basematerialNode.getAttribute( 'name' ); // required
			basematerialData[ 'displaycolor' ] = basematerialNode.getAttribute( 'displaycolor' ); // required
			basematerialData[ 'displaypropertiesid' ] = basematerialNode.getAttribute( 'displaypropertiesid' );

			return basematerialData;

		}

		function parseMeshNode( meshNode ) {

			const meshData = {};

			const vertices = [];
			const vertexNodes = meshNode.querySelectorAll( 'vertices vertex' );

			for ( let i = 0; i < vertexNodes.length; i ++ ) {

				const vertexNode = vertexNodes[ i ];
				const x = vertexNode.getAttribute( 'x' );
				const y = vertexNode.getAttribute( 'y' );
				const z = vertexNode.getAttribute( 'z' );

				vertices.push( parseFloat( x ), parseFloat( y ), parseFloat( z ) );

			}

			meshData[ 'vertices' ] = new Float32Array( vertices );

			const triangleProperties = [];
			const triangles = [];
			const triangleNodes = meshNode.querySelectorAll( 'triangles triangle' );

			for ( let i = 0; i < triangleNodes.length; i ++ ) {

				const triangleNode = triangleNodes[ i ];
				const v1 = triangleNode.getAttribute( 'v1' );
				const v2 = triangleNode.getAttribute( 'v2' );
				const v3 = triangleNode.getAttribute( 'v3' );
				const p1 = triangleNode.getAttribute( 'p1' );
				const p2 = triangleNode.getAttribute( 'p2' );
				const p3 = triangleNode.getAttribute( 'p3' );
				const pid = triangleNode.getAttribute( 'pid' );

				const triangleProperty = {};

				triangleProperty[ 'v1' ] = parseInt( v1, 10 );
				triangleProperty[ 'v2' ] = parseInt( v2, 10 );
				triangleProperty[ 'v3' ] = parseInt( v3, 10 );

				triangles.push( triangleProperty[ 'v1' ], triangleProperty[ 'v2' ], triangleProperty[ 'v3' ] );

				// optional

				if ( p1 ) {

					triangleProperty[ 'p1' ] = parseInt( p1, 10 );

				}

				if ( p2 ) {

					triangleProperty[ 'p2' ] = parseInt( p2, 10 );

				}

				if ( p3 ) {

					triangleProperty[ 'p3' ] = parseInt( p3, 10 );

				}

				if ( pid ) {

					triangleProperty[ 'pid' ] = pid;

				}

				// PATCH: proprietary per-triangle paint code (Bambu/Orca: paint_color;
				// Prusa: slic3rpe:mmu_segmentation). Decoded later into colored geometry.
				const paint = triangleNode.getAttribute( 'paint_color' )
					|| triangleNode.getAttribute( 'slic3rpe:mmu_segmentation' )
					|| triangleNode.getAttribute( 'mmu_segmentation' );

				if ( paint ) {

					triangleProperty[ 'pc' ] = paint;

				}

				if ( 0 < Object.keys( triangleProperty ).length ) {

					triangleProperties.push( triangleProperty );

				}

			}

			meshData[ 'triangleProperties' ] = triangleProperties;
			meshData[ 'triangles' ] = new Uint32Array( triangles );

			return meshData;

		}

		function parseComponentsNode( componentsNode ) {

			const components = [];

			const componentNodes = componentsNode.querySelectorAll( 'component' );

			for ( let i = 0; i < componentNodes.length; i ++ ) {

				const componentNode = componentNodes[ i ];
				const componentData = parseComponentNode( componentNode );
				components.push( componentData );

			}

			return components;

		}

		function parseComponentNode( componentNode ) {

			const componentData = {};

			componentData[ 'objectId' ] = componentNode.getAttribute( 'objectid' ); // required

			// PATCH: production extension — the referenced object may live in another part.
			componentData[ 'path' ] = componentNode.getAttribute( 'p:path' );

			const transform = componentNode.getAttribute( 'transform' );

			if ( transform ) {

				componentData[ 'transform' ] = parseTransform( transform );

			}

			return componentData;

		}

		function parseTransform( transform ) {

			const t = [];
			transform.split( ' ' ).forEach( function ( s ) {

				t.push( parseFloat( s ) );

			} );

			const matrix = new Matrix4();
			matrix.set(
				t[ 0 ], t[ 3 ], t[ 6 ], t[ 9 ],
				t[ 1 ], t[ 4 ], t[ 7 ], t[ 10 ],
				t[ 2 ], t[ 5 ], t[ 8 ], t[ 11 ],
				 0.0, 0.0, 0.0, 1.0
			);

			return matrix;

		}

		function parseObjectNode( objectNode ) {

			const objectData = {
				type: objectNode.getAttribute( 'type' )
			};

			const id = objectNode.getAttribute( 'id' );

			if ( id ) {

				objectData[ 'id' ] = id;

			}

			const pid = objectNode.getAttribute( 'pid' );

			if ( pid ) {

				objectData[ 'pid' ] = pid;

			}

			const pindex = objectNode.getAttribute( 'pindex' );

			if ( pindex ) {

				objectData[ 'pindex' ] = pindex;

			}

			const thumbnail = objectNode.getAttribute( 'thumbnail' );

			if ( thumbnail ) {

				objectData[ 'thumbnail' ] = thumbnail;

			}

			const partnumber = objectNode.getAttribute( 'partnumber' );

			if ( partnumber ) {

				objectData[ 'partnumber' ] = partnumber;

			}

			const name = objectNode.getAttribute( 'name' );

			if ( name ) {

				objectData[ 'name' ] = name;

			}

			const meshNode = objectNode.querySelector( 'mesh' );

			if ( meshNode ) {

				objectData[ 'mesh' ] = parseMeshNode( meshNode );

			}

			const componentsNode = objectNode.querySelector( 'components' );

			if ( componentsNode ) {

				objectData[ 'components' ] = parseComponentsNode( componentsNode );

			}

			return objectData;

		}

		function parseResourcesNode( resourcesNode ) {

			const resourcesData = {};

			resourcesData[ 'basematerials' ] = {};
			const basematerialsNodes = resourcesNode.querySelectorAll( 'basematerials' );

			for ( let i = 0; i < basematerialsNodes.length; i ++ ) {

				const basematerialsNode = basematerialsNodes[ i ];
				const basematerialsData = parseBasematerialsNode( basematerialsNode );
				resourcesData[ 'basematerials' ][ basematerialsData[ 'id' ] ] = basematerialsData;

			}

			//

			resourcesData[ 'texture2d' ] = {};
			const textures2DNodes = resourcesNode.querySelectorAll( 'texture2d' );

			for ( let i = 0; i < textures2DNodes.length; i ++ ) {

				const textures2DNode = textures2DNodes[ i ];
				const texture2DData = parseTexture2DNode( textures2DNode );
				resourcesData[ 'texture2d' ][ texture2DData[ 'id' ] ] = texture2DData;

			}

			//

			resourcesData[ 'colorgroup' ] = {};
			const colorGroupNodes = resourcesNode.querySelectorAll( 'colorgroup' );

			for ( let i = 0; i < colorGroupNodes.length; i ++ ) {

				const colorGroupNode = colorGroupNodes[ i ];
				const colorGroupData = parseColorGroupNode( colorGroupNode );
				resourcesData[ 'colorgroup' ][ colorGroupData[ 'id' ] ] = colorGroupData;

			}

			//

			const implicitFunctionNodes = resourcesNode.querySelectorAll( 'implicitfunction' );

			if ( implicitFunctionNodes.length > 0 ) {

				resourcesData[ 'implicitfunction' ] = {};

			}


			for ( let i = 0; i < implicitFunctionNodes.length; i ++ ) {

				const implicitFunctionNode = implicitFunctionNodes[ i ];
				const implicitFunctionData = parseImplicitFunctionNode( implicitFunctionNode );
				resourcesData[ 'implicitfunction' ][ implicitFunctionData[ 'id' ] ] = implicitFunctionData;

			}

			//

			resourcesData[ 'pbmetallicdisplayproperties' ] = {};
			const pbmetallicdisplaypropertiesNodes = resourcesNode.querySelectorAll( 'pbmetallicdisplayproperties' );

			for ( let i = 0; i < pbmetallicdisplaypropertiesNodes.length; i ++ ) {

				const pbmetallicdisplaypropertiesNode = pbmetallicdisplaypropertiesNodes[ i ];
				const pbmetallicdisplaypropertiesData = parseMetallicDisplaypropertiesNode( pbmetallicdisplaypropertiesNode );
				resourcesData[ 'pbmetallicdisplayproperties' ][ pbmetallicdisplaypropertiesData[ 'id' ] ] = pbmetallicdisplaypropertiesData;

			}

			//

			resourcesData[ 'texture2dgroup' ] = {};
			const textures2DGroupNodes = resourcesNode.querySelectorAll( 'texture2dgroup' );

			for ( let i = 0; i < textures2DGroupNodes.length; i ++ ) {

				const textures2DGroupNode = textures2DGroupNodes[ i ];
				const textures2DGroupData = parseTextures2DGroupNode( textures2DGroupNode );
				resourcesData[ 'texture2dgroup' ][ textures2DGroupData[ 'id' ] ] = textures2DGroupData;

			}

			//

			resourcesData[ 'object' ] = {};
			const objectNodes = resourcesNode.querySelectorAll( 'object' );

			for ( let i = 0; i < objectNodes.length; i ++ ) {

				const objectNode = objectNodes[ i ];
				const objectData = parseObjectNode( objectNode );
				resourcesData[ 'object' ][ objectData[ 'id' ] ] = objectData;

			}

			return resourcesData;

		}

		function parseBuildNode( buildNode ) {

			const buildData = [];
			const itemNodes = buildNode.querySelectorAll( 'item' );

			for ( let i = 0; i < itemNodes.length; i ++ ) {

				const itemNode = itemNodes[ i ];
				const buildItem = {
					objectId: itemNode.getAttribute( 'objectid' ),
					// PATCH: production extension — item may reference an object in another part.
					path: itemNode.getAttribute( 'p:path' )
				};
				const transform = itemNode.getAttribute( 'transform' );

				if ( transform ) {

					buildItem[ 'transform' ] = parseTransform( transform );

				}

				buildData.push( buildItem );

			}

			return buildData;

		}

		function parseModelNode( modelNode ) {

			const modelData = { unit: modelNode.getAttribute( 'unit' ) || 'millimeter' };
			const metadataNodes = modelNode.querySelectorAll( 'metadata' );

			if ( metadataNodes ) {

				modelData[ 'metadata' ] = parseMetadataNodes( metadataNodes );

			}

			const resourcesNode = modelNode.querySelector( 'resources' );

			if ( resourcesNode ) {

				modelData[ 'resources' ] = parseResourcesNode( resourcesNode );

			}

			const buildNode = modelNode.querySelector( 'build' );

			if ( buildNode ) {

				modelData[ 'build' ] = parseBuildNode( buildNode );

			}

			return modelData;

		}

		function buildTexture( texture2dgroup, objects, modelData, textureData ) {

			const texid = texture2dgroup.texid;
			const texture2ds = modelData.resources.texture2d;
			const texture2d = texture2ds[ texid ];

			if ( texture2d ) {

				const data = textureData[ texture2d.path ];
				const type = texture2d.contenttype;

				const blob = new Blob( [ data ], { type: type } );
				const sourceURI = URL.createObjectURL( blob );

				const texture = textureLoader.load( sourceURI, function () {

					URL.revokeObjectURL( sourceURI );

				} );

				texture.colorSpace = COLOR_SPACE_3MF;

				// texture parameters

				switch ( texture2d.tilestyleu ) {

					case 'wrap':
						texture.wrapS = RepeatWrapping;
						break;

					case 'mirror':
						texture.wrapS = MirroredRepeatWrapping;
						break;

					case 'none':
					case 'clamp':
						texture.wrapS = ClampToEdgeWrapping;
						break;

					default:
						texture.wrapS = RepeatWrapping;

				}

				switch ( texture2d.tilestylev ) {

					case 'wrap':
						texture.wrapT = RepeatWrapping;
						break;

					case 'mirror':
						texture.wrapT = MirroredRepeatWrapping;
						break;

					case 'none':
					case 'clamp':
						texture.wrapT = ClampToEdgeWrapping;
						break;

					default:
						texture.wrapT = RepeatWrapping;

				}

				switch ( texture2d.filter ) {

					case 'auto':
						texture.magFilter = LinearFilter;
						texture.minFilter = LinearMipmapLinearFilter;
						break;

					case 'linear':
						texture.magFilter = LinearFilter;
						texture.minFilter = LinearFilter;
						texture.generateMipmaps = false;
						break;

					case 'nearest':
						texture.magFilter = NearestFilter;
						texture.minFilter = NearestFilter;
						texture.generateMipmaps = false;
						break;

					default:
						texture.magFilter = LinearFilter;
						texture.minFilter = LinearMipmapLinearFilter;

				}

				return texture;

			} else {

				return null;

			}

		}

		function buildBasematerialsMeshes( basematerials, triangleProperties, meshData, objects, modelData, textureData, objectData ) {

			const objectPindex = objectData.pindex;

			const materialMap = {};

			for ( let i = 0, l = triangleProperties.length; i < l; i ++ ) {

				const triangleProperty = triangleProperties[ i ];
				const pindex = ( triangleProperty.p1 !== undefined ) ? triangleProperty.p1 : objectPindex;

				if ( materialMap[ pindex ] === undefined ) materialMap[ pindex ] = [];

				materialMap[ pindex ].push( triangleProperty );

			}

			//

			const keys = Object.keys( materialMap );
			const meshes = [];

			for ( let i = 0, l = keys.length; i < l; i ++ ) {

				const materialIndex = keys[ i ];
				const trianglePropertiesProps = materialMap[ materialIndex ];
				const basematerialData = basematerials.basematerials[ materialIndex ];
				const material = getBuild( basematerialData, objects, modelData, textureData, objectData, buildBasematerial );

				//

				const geometry = new BufferGeometry();

				const positionData = [];

				const vertices = meshData.vertices;

				for ( let j = 0, jl = trianglePropertiesProps.length; j < jl; j ++ ) {

					const triangleProperty = trianglePropertiesProps[ j ];

					positionData.push( vertices[ ( triangleProperty.v1 * 3 ) + 0 ] );
					positionData.push( vertices[ ( triangleProperty.v1 * 3 ) + 1 ] );
					positionData.push( vertices[ ( triangleProperty.v1 * 3 ) + 2 ] );

					positionData.push( vertices[ ( triangleProperty.v2 * 3 ) + 0 ] );
					positionData.push( vertices[ ( triangleProperty.v2 * 3 ) + 1 ] );
					positionData.push( vertices[ ( triangleProperty.v2 * 3 ) + 2 ] );

					positionData.push( vertices[ ( triangleProperty.v3 * 3 ) + 0 ] );
					positionData.push( vertices[ ( triangleProperty.v3 * 3 ) + 1 ] );
					positionData.push( vertices[ ( triangleProperty.v3 * 3 ) + 2 ] );


				}

				geometry.setAttribute( 'position', new Float32BufferAttribute( positionData, 3 ) );

				//

				const mesh = new Mesh( geometry, material );
				meshes.push( mesh );

			}

			return meshes;

		}

		function buildTexturedMesh( texture2dgroup, triangleProperties, meshData, objects, modelData, textureData, objectData ) {

			// geometry

			const geometry = new BufferGeometry();

			const positionData = [];
			const uvData = [];

			const vertices = meshData.vertices;
			const uvs = texture2dgroup.uvs;

			for ( let i = 0, l = triangleProperties.length; i < l; i ++ ) {

				const triangleProperty = triangleProperties[ i ];

				positionData.push( vertices[ ( triangleProperty.v1 * 3 ) + 0 ] );
				positionData.push( vertices[ ( triangleProperty.v1 * 3 ) + 1 ] );
				positionData.push( vertices[ ( triangleProperty.v1 * 3 ) + 2 ] );

				positionData.push( vertices[ ( triangleProperty.v2 * 3 ) + 0 ] );
				positionData.push( vertices[ ( triangleProperty.v2 * 3 ) + 1 ] );
				positionData.push( vertices[ ( triangleProperty.v2 * 3 ) + 2 ] );

				positionData.push( vertices[ ( triangleProperty.v3 * 3 ) + 0 ] );
				positionData.push( vertices[ ( triangleProperty.v3 * 3 ) + 1 ] );
				positionData.push( vertices[ ( triangleProperty.v3 * 3 ) + 2 ] );

				//

				uvData.push( uvs[ ( triangleProperty.p1 * 2 ) + 0 ] );
				uvData.push( uvs[ ( triangleProperty.p1 * 2 ) + 1 ] );

				uvData.push( uvs[ ( triangleProperty.p2 * 2 ) + 0 ] );
				uvData.push( uvs[ ( triangleProperty.p2 * 2 ) + 1 ] );

				uvData.push( uvs[ ( triangleProperty.p3 * 2 ) + 0 ] );
				uvData.push( uvs[ ( triangleProperty.p3 * 2 ) + 1 ] );

			}

			geometry.setAttribute( 'position', new Float32BufferAttribute( positionData, 3 ) );
			geometry.setAttribute( 'uv', new Float32BufferAttribute( uvData, 2 ) );

			// material

			const texture = getBuild( texture2dgroup, objects, modelData, textureData, objectData, buildTexture );

			const material = new MeshPhongMaterial( { map: texture, flatShading: true } );

			// mesh

			const mesh = new Mesh( geometry, material );

			return mesh;

		}

		function buildVertexColorMesh( colorgroup, triangleProperties, meshData, objectData ) {

			// geometry

			const geometry = new BufferGeometry();

			const positionData = [];
			const colorData = [];

			const vertices = meshData.vertices;
			const colors = colorgroup.colors;

			for ( let i = 0, l = triangleProperties.length; i < l; i ++ ) {

				const triangleProperty = triangleProperties[ i ];

				const v1 = triangleProperty.v1;
				const v2 = triangleProperty.v2;
				const v3 = triangleProperty.v3;

				positionData.push( vertices[ ( v1 * 3 ) + 0 ] );
				positionData.push( vertices[ ( v1 * 3 ) + 1 ] );
				positionData.push( vertices[ ( v1 * 3 ) + 2 ] );

				positionData.push( vertices[ ( v2 * 3 ) + 0 ] );
				positionData.push( vertices[ ( v2 * 3 ) + 1 ] );
				positionData.push( vertices[ ( v2 * 3 ) + 2 ] );

				positionData.push( vertices[ ( v3 * 3 ) + 0 ] );
				positionData.push( vertices[ ( v3 * 3 ) + 1 ] );
				positionData.push( vertices[ ( v3 * 3 ) + 2 ] );

				//

				const p1 = ( triangleProperty.p1 !== undefined ) ? triangleProperty.p1 : objectData.pindex;
				const p2 = ( triangleProperty.p2 !== undefined ) ? triangleProperty.p2 : p1;
				const p3 = ( triangleProperty.p3 !== undefined ) ? triangleProperty.p3 : p1;

				colorData.push( colors[ ( p1 * 3 ) + 0 ] );
				colorData.push( colors[ ( p1 * 3 ) + 1 ] );
				colorData.push( colors[ ( p1 * 3 ) + 2 ] );

				colorData.push( colors[ ( p2 * 3 ) + 0 ] );
				colorData.push( colors[ ( p2 * 3 ) + 1 ] );
				colorData.push( colors[ ( p2 * 3 ) + 2 ] );

				colorData.push( colors[ ( p3 * 3 ) + 0 ] );
				colorData.push( colors[ ( p3 * 3 ) + 1 ] );
				colorData.push( colors[ ( p3 * 3 ) + 2 ] );

			}

			geometry.setAttribute( 'position', new Float32BufferAttribute( positionData, 3 ) );
			geometry.setAttribute( 'color', new Float32BufferAttribute( colorData, 3 ) );

			// material

			const material = new MeshPhongMaterial( { vertexColors: true, flatShading: true } );

			// mesh

			const mesh = new Mesh( geometry, material );

			return mesh;

		}

		function buildDefaultMesh( meshData ) {

			const geometry = new BufferGeometry();
			geometry.setIndex( new BufferAttribute( meshData[ 'triangles' ], 1 ) );
			geometry.setAttribute( 'position', new BufferAttribute( meshData[ 'vertices' ], 3 ) );

			const material = new MeshPhongMaterial( {
				name: Loader.DEFAULT_MATERIAL_NAME,
				color: 0xffffff,
				flatShading: true
			} );

			const mesh = new Mesh( geometry, material );

			return mesh;

		}

		function buildMeshes( resourceMap, meshData, objects, modelData, textureData, objectData ) {

			const keys = Object.keys( resourceMap );
			const meshes = [];

			for ( let i = 0, il = keys.length; i < il; i ++ ) {

				const resourceId = keys[ i ];
				const triangleProperties = resourceMap[ resourceId ];
				const resourceType = getResourceType( resourceId, modelData );

				switch ( resourceType ) {

					case 'material':
						const basematerials = modelData.resources.basematerials[ resourceId ];
						const newMeshes = buildBasematerialsMeshes( basematerials, triangleProperties, meshData, objects, modelData, textureData, objectData );

						for ( let j = 0, jl = newMeshes.length; j < jl; j ++ ) {

							meshes.push( newMeshes[ j ] );

						}

						break;

					case 'texture':
						const texture2dgroup = modelData.resources.texture2dgroup[ resourceId ];
						meshes.push( buildTexturedMesh( texture2dgroup, triangleProperties, meshData, objects, modelData, textureData, objectData ) );
						break;

					case 'vertexColors':
						const colorgroup = modelData.resources.colorgroup[ resourceId ];
						meshes.push( buildVertexColorMesh( colorgroup, triangleProperties, meshData, objectData ) );
						break;

					case 'default':
						meshes.push( buildDefaultMesh( meshData ) );
						break;

					default:
						console.error( 'THREE.3MFLoader: Unsupported resource type.' );

				}

			}

			if ( objectData.name ) {

				for ( let i = 0; i < meshes.length; i ++ ) {

					meshes[ i ].name = objectData.name;

				}

			}

			return meshes;

		}

		function getResourceType( pid, modelData ) {

			if ( modelData.resources.texture2dgroup[ pid ] !== undefined ) {

				return 'texture';

			} else if ( modelData.resources.basematerials[ pid ] !== undefined ) {

				return 'material';

			} else if ( modelData.resources.colorgroup[ pid ] !== undefined ) {

				return 'vertexColors';

			} else if ( pid === 'default' ) {

				return 'default';

			} else {

				return undefined;

			}

		}

		function analyzeObject( meshData, objectData ) {

			const resourceMap = {};

			const triangleProperties = meshData[ 'triangleProperties' ];

			const objectPid = objectData.pid;

			for ( let i = 0, l = triangleProperties.length; i < l; i ++ ) {

				const triangleProperty = triangleProperties[ i ];
				let pid = ( triangleProperty.pid !== undefined ) ? triangleProperty.pid : objectPid;

				if ( pid === undefined ) pid = 'default';

				if ( resourceMap[ pid ] === undefined ) resourceMap[ pid ] = [];

				resourceMap[ pid ].push( triangleProperty );

			}

			return resourceMap;

		}

		// PATCH: does this mesh carry any proprietary paint codes?
		function meshHasPaint( meshData ) {

			const props = meshData.triangleProperties;
			for ( let i = 0, l = props.length; i < l; i ++ ) {

				if ( props[ i ].pc !== undefined ) return true;

			}

			return false;

		}

		// PATCH: build a single vertex-colored mesh by decoding each triangle's paint
		// code into colored sub-triangles. State n -> palette index (n - 1); state 0
		// (unpainted) -> base color (palette index 0).
		function buildPaintedMesh( meshData ) {

			const positions = [];
			const colors = [];
			const vertices = meshData.vertices;
			const props = meshData.triangleProperties;

			const palette = documentPalette;
			const paletteLen = palette ? palette.length / 3 : 0;
			const baseR = documentBaseColor[ 0 ];
			const baseG = documentBaseColor[ 1 ];
			const baseB = documentBaseColor[ 2 ];

			const sink = ( ax, ay, az, bx, by, bz, cx, cy, cz, state ) => {

				const idx = state - 1;
				let r = baseR, g = baseG, b = baseB;
				if ( idx >= 0 && idx < paletteLen ) {

					r = palette[ idx * 3 ];
					g = palette[ idx * 3 + 1 ];
					b = palette[ idx * 3 + 2 ];

				}

				positions.push( ax, ay, az, bx, by, bz, cx, cy, cz );
				colors.push( r, g, b, r, g, b, r, g, b );

			};

			for ( let i = 0, l = props.length; i < l; i ++ ) {

				const p = props[ i ];
				const a = p.v1 * 3, b = p.v2 * 3, c = p.v3 * 3;
				decodePaintedTriangle(
					vertices[ a ], vertices[ a + 1 ], vertices[ a + 2 ],
					vertices[ b ], vertices[ b + 1 ], vertices[ b + 2 ],
					vertices[ c ], vertices[ c + 1 ], vertices[ c + 2 ],
					p.pc,
					sink,
				);

			}

			const geometry = new BufferGeometry();
			geometry.setAttribute( 'position', new Float32BufferAttribute( positions, 3 ) );
			geometry.setAttribute( 'color', new Float32BufferAttribute( colors, 3 ) );
			geometry.computeVertexNormals();

			const material = new MeshStandardMaterial( {
				vertexColors: true,
				metalness: 0.1,
				roughness: 0.55,
				flatShading: false,
			} );

			return new Mesh( geometry, material );

		}

		function buildGroup( meshData, objects, modelData, textureData, objectData ) {

			const group = new Group();

			// PATCH: when the mesh is painted and we have a palette, render decoded colors.
			if ( documentPalette && meshHasPaint( meshData ) ) {

				group.add( buildPaintedMesh( meshData ) );
				return group;

			}

			const resourceMap = analyzeObject( meshData, objectData );
			const meshes = buildMeshes( resourceMap, meshData, objects, modelData, textureData, objectData );

			for ( let i = 0, l = meshes.length; i < l; i ++ ) {

				group.add( meshes[ i ] );

			}

			return group;

		}

		function applyExtensions( extensions, meshData, modelXml ) {

			if ( ! extensions ) {

				return;

			}

			const availableExtensions = [];
			const keys = Object.keys( extensions );

			for ( let i = 0; i < keys.length; i ++ ) {

				const ns = keys[ i ];

				for ( let j = 0; j < scope.availableExtensions.length; j ++ ) {

					const extension = scope.availableExtensions[ j ];

					if ( extension.ns === ns ) {

						availableExtensions.push( extension );

					}

				}

			}

			for ( let i = 0; i < availableExtensions.length; i ++ ) {

				const extension = availableExtensions[ i ];
				extension.apply( modelXml, extensions[ extension[ 'ns' ] ], meshData );

			}

		}

		function getBuild( data, objects, modelData, textureData, objectData, builder ) {

			if ( data.build !== undefined ) return data.build;

			data.build = builder( data, objects, modelData, textureData, objectData );

			return data.build;

		}

		function buildBasematerial( materialData, objects, modelData ) {

			let material;

			const displaypropertiesid = materialData.displaypropertiesid;
			const pbmetallicdisplayproperties = modelData.resources.pbmetallicdisplayproperties;

			if ( displaypropertiesid !== null && pbmetallicdisplayproperties[ displaypropertiesid ] !== undefined ) {

				// metallic display property, use StandardMaterial

				const pbmetallicdisplayproperty = pbmetallicdisplayproperties[ displaypropertiesid ];
				const metallicData = pbmetallicdisplayproperty.data[ materialData.index ];

				material = new MeshStandardMaterial( { flatShading: true, roughness: metallicData.roughness, metalness: metallicData.metallicness } );

			} else {

				// otherwise use PhongMaterial

				material = new MeshPhongMaterial( { flatShading: true } );

			}

			material.name = materialData.name;

			// displaycolor MUST be specified with a value of a 6 or 8 digit hexadecimal number, e.g. "#RRGGBB" or "#RRGGBBAA"

			const displaycolor = materialData.displaycolor;

			const color = displaycolor.substring( 0, 7 );
			material.color.setStyle( color, COLOR_SPACE_3MF );

			// process alpha if set

			if ( displaycolor.length === 9 ) {

				material.opacity = parseInt( displaycolor.charAt( 7 ) + displaycolor.charAt( 8 ), 16 ) / 255;

			}

			return material;

		}

		function buildComposite( compositeData, objects, modelData, textureData, currentPath ) {

			const composite = new Group();

			for ( let j = 0; j < compositeData.length; j ++ ) {

				const component = compositeData[ j ];

				// PATCH: resolve the referenced object against its declaring part (p:path),
				// defaulting to the current part when no path is given.
				const refPath = resolvePartPath( component.path, currentPath );
				const refModelData = modelsByPath[ refPath ];

				if ( refModelData === undefined ) {

					console.error( 'THREE.ThreeMFLoader: component references missing model part:', refPath );
					continue;

				}

				const key = refPath + '|' + component.objectId;
				let build = objects[ key ];

				if ( build === undefined ) {

					buildObject( component.objectId, objects, refModelData, textureData, refPath );
					build = objects[ key ];

				}

				if ( build === undefined ) continue;

				const object3D = build.clone();

				// apply component transform

				const transform = component.transform;

				if ( transform ) {

					object3D.applyMatrix4( transform );

				}

				composite.add( object3D );

			}

			return composite;

		}

		function buildObject( objectId, objects, modelData, textureData, modelPath ) {

			const objectData = modelData[ 'resources' ][ 'object' ][ objectId ];

			// PATCH: a dangling reference should be skipped, not throw the whole parse.
			if ( objectData === undefined ) {

				console.error( 'THREE.ThreeMFLoader: object', objectId, 'not found in part', modelPath );
				return;

			}

			// PATCH: object ids are unique only within a part, so key builds by path|id.
			const key = modelPath + '|' + objectId;

			if ( objectData[ 'mesh' ] ) {

				const meshData = objectData[ 'mesh' ];

				const extensions = modelData[ 'extensions' ];
				const modelXml = modelData[ 'xml' ];

				applyExtensions( extensions, meshData, modelXml );

				objects[ key ] = getBuild( meshData, objects, modelData, textureData, objectData, buildGroup );

			} else {

				const compositeData = objectData[ 'components' ];

				// PATCH: thread the current part path so components resolve relative to it.
				objects[ key ] = getBuild( compositeData, objects, modelData, textureData, objectData, ( d, o, m, t ) => buildComposite( d, o, m, t, modelPath ) );

			}

			if ( objectData.name ) {

				objects[ key ].name = objectData.name;

			}

			if ( modelData.resources.implicitfunction ) {

				console.warn( 'THREE.ThreeMFLoader: Implicit Functions are implemented in data-only.', modelData.resources.implicitfunction );

			}

		}

		function buildObjects( data3mf ) {

			const modelsData = data3mf.model;
			const modelRels = data3mf.modelRels;
			const objects = {};
			const modelsKeys = Object.keys( modelsData );
			const textureData = {};

			// PATCH: expose all parts by path so cross-part references can be resolved.
			modelsByPath = modelsData;

			// evaluate model relationships to textures

			if ( modelRels ) {

				for ( let i = 0, l = modelRels.length; i < l; i ++ ) {

					const modelRel = modelRels[ i ];
					const textureKey = modelRel.target.substring( 1 );

					if ( data3mf.texture[ textureKey ] ) {

						textureData[ modelRel.target ] = data3mf.texture[ textureKey ];

					}

				}

			}

			// start build

			for ( let i = 0; i < modelsKeys.length; i ++ ) {

				const modelsKey = modelsKeys[ i ];
				const modelData = modelsData[ modelsKey ];

				// PATCH: some parts (metadata-only) carry no object resources — skip them.
				const resources = modelData[ 'resources' ];
				if ( ! resources || ! resources[ 'object' ] ) continue;

				const objectIds = Object.keys( resources[ 'object' ] );

				for ( let j = 0; j < objectIds.length; j ++ ) {

					const objectId = objectIds[ j ];

					// PATCH: pass the part path so ids are keyed/resolved per part.
					buildObject( objectId, objects, modelData, textureData, modelsKey );

				}

			}

			return objects;

		}

		function fetch3DModelPart( rels ) {

			for ( let i = 0; i < rels.length; i ++ ) {

				const rel = rels[ i ];
				const extension = rel.target.split( '.' ).pop();

				if ( extension.toLowerCase() === 'model' ) return rel;

			}

		}

		function build( objects, data3mf ) {

			const group = new Group();

			const relationship = fetch3DModelPart( data3mf[ 'rels' ] );
			// PATCH: normalized root-part key; build items resolve against it by default.
			const rootPath = relationship[ 'target' ].substring( 1 );
			const buildData = data3mf.model[ rootPath ][ 'build' ];

			for ( let i = 0; i < buildData.length; i ++ ) {

				const buildItem = buildData[ i ];

				// PATCH: honor an item-level p:path and look up the path|id key.
				const refPath = resolvePartPath( buildItem[ 'path' ], rootPath );
				const built = objects[ refPath + '|' + buildItem[ 'objectId' ] ];

				if ( built === undefined ) {

					console.error( 'THREE.ThreeMFLoader: build item references missing object', buildItem[ 'objectId' ], 'in', refPath );
					continue;

				}

				const object3D = built.clone();

				// apply transform

				const transform = buildItem[ 'transform' ];

				if ( transform ) {

					object3D.applyMatrix4( transform );

				}

				group.add( object3D );

			}

			return group;

		}

		const data3mf = loadDocument( data );
		const objects = buildObjects( data3mf );

		return build( objects, data3mf );

	}

	addExtension( extension ) {

		this.availableExtensions.push( extension );

	}

}

export { ThreeMFLoader };
