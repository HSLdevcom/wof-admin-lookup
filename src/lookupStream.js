'use strict';

const _ = require('lodash');
const parallelStream = require('pelias-parallel-stream');
const peliasLogger = require( 'pelias-logger' );
const getAdminLayers = require( './getAdminLayers' );
const peliasConfig = require( 'pelias-config' ).generate();

const dropUnmapped = peliasConfig.imports && peliasConfig.imports.adminLookup && peliasConfig.imports.adminLookup.dropUnmapped;

//defaults to nowhere
const optsArg = {
  transports: []
};
//only prints to suspect records log if flag is set
optsArg.transports.push(new peliasLogger.winston.transports.File( {
  filename: 'suspect_wof_records.log',
  timestamp: false
}));

const logger = peliasLogger.get( 'wof-admin-lookup', optsArg );

function hasAnyMultiples(result) {
  return Object.keys(result).some((element) => {
    return result[element].length > 1;
  });
}

function createPipResolverStream(pipResolver) {
  return function (doc, enc, callback) {
    // don't do anything if there's no centroid
    if (_.isEmpty(doc.getCentroid())) {
      if (dropUnmapped) { // don't pass doc forward
        return callback();
      }
      return callback(null, doc);
    }

    pipResolver.lookup(doc.getCentroid(), getAdminLayers(doc.getLayer()), (err, result) => {
      if (err) {
        // if there's an error, just log it and move on
        logger.error(`PIP server failed: ${(err.message || JSON.stringify(err))}`, {
          id: doc.getGid(),
          lat: doc.getCentroid().lat,
          lon: doc.getCentroid().lon
        });
        // don't pass the unmodified doc along
        return callback();
      }

      if (dropUnmapped && _.isEmpty(result)) {
        logger.info('zero admins', {
          centroid: doc.getCentroid(),
          doc: doc
        });
        // skip docs which have no admin hierachy
        return callback();
      }

      // log results w/o country OR any multiples
      if (_.isEmpty(result.country)) {
        logger.info('no country', {
          centroid: doc.getCentroid(),
          result: result
        });
      }

      if (hasAnyMultiples(result)) {
        logger.info('multiple values', {
          centroid: doc.getCentroid(),
          result: result
        });
      }

      doc.getParentFields()
        // filter out placetypes for which there are no values
        .filter((placetype) => { return !_.isEmpty(result[placetype]); } )
        // assign parents into the doc
        .forEach((placetype) => {
          const values = result[placetype];

          try {
            var name = values[0].name;
            // addParent can throw an error if, for example, name is an empty string
            if (Array.isArray(name)) { // can now be an array
              for(var i=0; i<name.length; i++) {
                doc.addParent(placetype, name[i], values[0].id.toString(), values[0].abbr);
              }
            } else {
              doc.addParent(placetype, name, values[0].id.toString(), values[0].abbr);
            }
          }
          catch (err) {
            logger.info('invalid value', {
              centroid: doc.getCentroid(),
              result: {
                type: placetype,
                values: values
              }
            });
          }

        }
      );

      if ( result.postalcode ) { // want zip as adddress part
        var postalcode = result.postalcode[0].name;
        if (postalcode && postalcode !== '') {
          doc.setAddress('zip', postalcode);
        }
      }

      callback(null, doc);

    });
  };
}

function createPipResolverEnd(pipResolver) {
  return () => {
    if (typeof pipResolver.end === 'function') {
      pipResolver.end();
    }
  };
}

module.exports = function(pipResolver, maxConcurrentReqs) {
  if (!pipResolver) {
    throw new Error('valid pipResolver required to be passed in as the first parameter');
  }

  const pipResolverStream = createPipResolverStream(pipResolver);
  const end = createPipResolverEnd(pipResolver);

  return parallelStream(maxConcurrentReqs || 1, pipResolverStream, end);

};
