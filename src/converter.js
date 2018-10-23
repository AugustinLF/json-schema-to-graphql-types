const {
  GraphQLObjectType, GraphQLString, GraphQLInt, GraphQLNonNull, GraphQLUnionType,
  GraphQLInputObjectType, GraphQLFloat, GraphQLList, GraphQLBoolean, GraphQLEnumType
} = require('graphql');
const isEmpty = require('lodash/isEmpty');
const keyBy = require('lodash/keyBy');
const mapValues = require('lodash/mapValues');
const map = require('lodash/map');
const omitBy = require('lodash/omitBy');
const includes = require('lodash/includes');
const uppercamelcase = require('uppercamelcase');
const camelcase = require('camelcase');
const escodegen = require('escodegen');

const INPUT_SUFFIX = 'In';
const DROP_ATTRIBUTE_MARKER = Symbol('A marker to drop the attributes');

function mapBasicAttributeType (type, attributeName) {
  switch (type) {
    case 'string': return GraphQLString;
    case 'integer': return GraphQLInt;
    case 'number': return GraphQLFloat;
    case 'boolean': return GraphQLBoolean;
    default: throw new Error(`A JSON Schema attribute type ${type} on attribute ${attributeName} does not have a known GraphQL mapping`);
  }
}

function toSafeEnumKey (value) {
  if (/^[0-9]/.test(value)) {
    value = 'VALUE_' + value;
  }

  switch (value) {
    case '<': return 'LT';
    case '<=': return 'LTE';
    case '>=': return 'GTE';
    case '>': return 'GT';
    default:
      return value.replace(/[^_a-zA-Z0-9]/g, '_');
  }
}

function buildEnumType (context, attributeName, enumValues) {
  const enumName = uppercamelcase(attributeName);
  const graphqlToJsonMap = keyBy(enumValues, toSafeEnumKey);

  context.enumMaps.set(attributeName, graphqlToJsonMap);
  const enumType = new GraphQLEnumType({
    name: enumName,
    values: mapValues(graphqlToJsonMap, function (value) {
      return {value};
    })
  });

  context.enumTypes.set(attributeName, enumType);
  return enumType;
}

function mapType (context, attributeDefinition, attributeName, buildingInputType) {
  const enumValues = attributeDefinition.enum;
  if (enumValues) {
    if (attributeDefinition.type !== 'string') {
      throw new Error(`The attribute ${attributeName} not supported because only conversion of string based enumertions are implemented`);
    }

    const existingEnum = context.enumTypes.get(attributeName);
    if (existingEnum) {
      return existingEnum;
    }

    return buildEnumType(context, attributeName, enumValues);
  }

  const typeReference = attributeDefinition.$ref;
  if (typeReference) {
    const typeMap = buildingInputType ? context.inputs : context.types;
    const referencedType = typeMap.get(typeReference);
    if (!referencedType) {
      if (context.types.get(typeReference) instanceof GraphQLUnionType && buildingInputType) {
        return DROP_ATTRIBUTE_MARKER;
      }
      throw new UnknownTypeReference(`The referenced type ${typeReference} (${buildingInputType}) is unknown in ${attributeName}`);
    }
    return referencedType;
  }

  return mapBasicAttributeType(attributeDefinition.type, attributeName);
}

// Handles any custom object types. It will create a GraphQLInputObjectType/GraphQLObjectType, and
// will map on all the properties of the object. Properties corresponding to arrays or object types
// will recursively call objectFromSchema again, since there can be nested objects. The simpler types
// will use mapType which doesn't need recursion
function objectFromSchema (context, typeName, schema, buildingInputType) {
  function getFields () {
    let fields;
    if (isEmpty(schema.properties)) {
      fields = {
        _typesWithoutFieldsAreNotAllowed_: {
          type: GraphQLString
        }
      };
    } else {
      fields = mapValues(schema.properties, function (attributeDefinition, attributeName) {
        const qualifiedAttributeName = `${typeName}.${attributeName}`;
        let type;
        if (attributeDefinition.type === 'array') {
          const itemName = attributeDefinition.items.$ref ? qualifiedAttributeName : `${qualifiedAttributeName}Item`;
          // TODO Is there a cleaner way to do that?
          const elementType = ['array', 'object'].includes(attributeDefinition.items.type)
            ? objectFromSchema(context, itemName, attributeDefinition.items, buildingInputType)
            : mapType(context, attributeDefinition.items, itemName, buildingInputType);
          if (elementType === DROP_ATTRIBUTE_MARKER) {
            return {type: DROP_ATTRIBUTE_MARKER};
          }
          type = GraphQLList(GraphQLNonNull(elementType));
        } else if (attributeDefinition.type === 'object') {
          type = objectFromSchema(context, qualifiedAttributeName, attributeDefinition, buildingInputType);
        } else {
          type = mapType(context, attributeDefinition, qualifiedAttributeName, buildingInputType);
        }
        const modifiedType = includes(schema.required, attributeName) ? GraphQLNonNull(type) : type;
        return {type: modifiedType};
      });
    }

    return omitBy(fields, {type: DROP_ATTRIBUTE_MARKER});
  }

  const name = uppercamelcase(`${typeName}${buildingInputType ? INPUT_SUFFIX : ''}`);
  // getFields need to be called lazily, since some types might not be available at the creation of
  // the object (with circular refs for instance)
  return buildingInputType
    ? new GraphQLInputObjectType({name, fields: () => getFields()})
    : new GraphQLObjectType({name, fields: () => getFields()});
}

function buildObjectType (context, typeName, schema) {
  const output = objectFromSchema(context, typeName, schema);
  const input = objectFromSchema(context, typeName, schema, true);

  return {input, output};
}

function buildUnionType (context, typeName, schema) {
  const output = new GraphQLUnionType({
    name: typeName,
    types: () => {
      return map(schema.switch, function (switchCase, caseIndex) {
        return mapType(context, switchCase.then, `${typeName}.switch[${caseIndex}]`);
      });
    }
  });

  // There are no input union types in GraphQL
  // https://github.com/facebook/graphql/issues/488
  return {output, input: undefined};
}

function convert (context, schema) {
  const typeName = schema.id;

  const typeBuilder = schema.switch ? buildUnionType : buildObjectType;
  const {input, output} = typeBuilder(context, typeName, schema);

  context.types.set(typeName, output);
  if (input) {
    context.inputs.set(typeName, input);
  }

  return {output, input};
}

function newContext () {
  return {
    types: new Map(),
    inputs: new Map(),
    enumTypes: new Map(),
    enumMaps: new Map()
  };
}

class UnknownTypeReference extends Error {
  constructor (message) {
    super(message);
    this.name = 'UnknownTypeReference';
  }
}

function getConvertEnumFromGraphQLCode (context, attributePath) {
  const valueMap = context.enumMaps.get(attributePath);

  const cases = map(valueMap, function (jsonValue, graphQlValue) {
    return {
      type: 'SwitchCase',
      test: {type: 'Literal', value: graphQlValue},
      consequent: [{
        type: 'ReturnStatement',
        argument: {type: 'Literal', value: jsonValue}
      }]
    };
  });

  const functionName = camelcase(`convert${attributePath}FromGraphQL`);

  const valueIdentifier = { type: 'Identifier', name: 'value' };
  return escodegen.generate({
    type: 'FunctionDeclaration',
    id: { type: 'Identifier', name: functionName },
    params: [ valueIdentifier ],
    body: {
      type: 'BlockStatement',
      body: [ {
        type: 'SwitchStatement',
        discriminant: valueIdentifier,
        cases
      }]
    }
  });
}

module.exports = {
  INPUT_SUFFIX,
  UnknownTypeReference,
  newContext,
  convert,
  getConvertEnumFromGraphQLCode
};
