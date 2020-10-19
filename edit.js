const { span, button, i, a, script } = require("@saltcorn/markup/tags");
const View = require("@saltcorn/data/models/view");
const Workflow = require("@saltcorn/data/models/workflow");
const Table = require("@saltcorn/data/models/table");
const Form = require("@saltcorn/data/models/form");
const Field = require("@saltcorn/data/models/field");
const db = require("@saltcorn/data/db");
const {
  stateFieldsToWhere,
  picked_fields_to_query,
} = require("@saltcorn/data/plugin-helper");

const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "views",
        form: async (context) => {
          const table = await Table.findOne({ id: context.table_id });
          const mytable = table;
          const fields = await table.getFields();
          const {
            child_field_list,
            child_relations,
          } = await table.get_child_relations();
          var agg_field_opts = [];
          /* child_relations.forEach(({ table, key_field }) => {
            table.fields
              .filter((f) => !f.calculated || f.stored)
              .forEach((f) => {
                agg_field_opts.push({
                  name: `${table.name}.${key_field.name}.${f.name}`,
                  label: `${table.name}.${key_field.name}&#8594;${f.name}`,
                });
              });
          });*/
          for (const { table, key_field } of child_relations) {
            const keyFields = table.fields.filter(
              (f) =>
                f.type === "Key" &&
                ![mytable.name, "users", "_sc_files"].includes(f.reftable_name)
            );
            for (const kf of keyFields) {
              const joined_table = await Table.findOne({
                name: kf.reftable_name,
              });
              if (!joined_table) continue;
              await joined_table.getFields();
              joined_table.fields.forEach((jf) => {
                agg_field_opts.push({
                  label: `${table.name}.${key_field.name}&#8594;${kf.name}&#8594;${jf.name}`,
                  name: `${table.name}.${key_field.name}.${kf.name}.${jf.name}`,
                });
              });
            }
          }
          return new Form({
            fields: [
              {
                name: "relation",
                label: "Relation",
                type: "String",
                required: true,
                attributes: {
                  options: agg_field_opts,
                },
              },
            ],
          });
        },
      },
    ],
  });
const get_state_fields = async (table_id, viewname, { columns }) => [
  {
    name: "id",
    type: "Integer",
    required: true,
  },
];

const run = async (table_id, viewname, { relation }, state, extra) => {
  const { id } = state;
  if (!id) return "need id";
  const relSplit = relation.split(".");
  if (relSplit.length < 4) {
    throw new Error(
      "EditBadges view incorrectly configured. No relation chosen"
    );
  }
  const rndid = `bs${Math.round(Math.random() * 100000)}`;
  const [relTableNm, relField, joinFieldNm, valField] = relSplit;
  const table = await Table.findOne({ id: table_id });

  const relTable = await Table.findOne({ name: relTableNm });
  await relTable.getFields();
  const joinField = relTable.fields.find((f) => f.name === joinFieldNm);
  const joinedTable = await Table.findOne({ name: joinField.reftable_name });

  const rows = await table.getJoinedRows({
    where: { id },
    aggregations: {
      _badges: {
        table: joinField.reftable_name,
        ref: "id",
        subselect: {
          field: joinFieldNm,
          table: relTable,
          whereField: relField,
        },
        field: valField,
        aggregate: "ARRAY_AGG",
      },
    },
  });

  const existing = (rows[0]._badges || [])
    .map(
      (b) =>
        span(
          { class: "badge badge-secondary" },
          b,
          a(
            {
              onclick: `(function(that){view_post('${viewname}', 'remove', {id:'${id}', value: '${b}'}, function(){$(that).closest('span').remove()})})(this);`,
            },
            i({ class: "ml-1 fas fa-lg fa-times" })
          )
        ) + "&nbsp;"
    )
    .join("");

  const possibles = await joinedTable.distinctValues(valField);
  const addbadge =
    span(
      {
        class: "badge badge-secondary",
        id: rndid,
        onclick: `add_badge_${rndid}('${rndid}', ${id})`,
      },
      i({ class: "fas fa-lg fa-plus" })
    ) +
    script(`function add_badge_${rndid}(divid, dbid){
      $('#'+divid).replaceWith(\`<select style="width:100px"class="form-control-sm" onchange="set_add_badge_${rndid}(this)">
        <option selected>Choose...</option>
        ${possibles.map((p) => `<option>${p}</option>`).join("")}       
      </select>
     \`)
  }
  function set_add_badge_${rndid}(that) {
    view_post('${viewname}', 'add', {id:'${id}', value: that.value}, function(){location.reload();})
  }
  `);
  return existing + addbadge;
};

const remove = async (table_id, viewname, { relation }, { id, value }) => {
  const relSplit = relation.split(".");
  const [joinTableNm, relField, joinFieldNm, valField] = relSplit;
  const joinTable = await Table.findOne({ name: joinTableNm });
  await joinTable.getFields();
  const joinField = joinTable.fields.find((f) => f.name === joinFieldNm);
  const schema = db.getTenantSchema();
  await db.query(
    `delete from "${schema}"."${db.sqlsanitize(joinTable.name)}" 
      where "${db.sqlsanitize(relField)}"=$1 and 
      "${db.sqlsanitize(joinFieldNm)}" in 
      (select id from 
        "${schema}"."${db.sqlsanitize(joinField.reftable_name)}" 
        where "${db.sqlsanitize(valField)}"=$2)`,
    [id, value]
  );
  return { json: { success: "ok" } };
};
const add = async (table_id, viewname, { relation }, { id, value }) => {
  const relSplit = relation.split(".");
  const [joinTableNm, relField, joinFieldNm, valField] = relSplit;
  const joinTable = await Table.findOne({ name: joinTableNm });
  await joinTable.getFields();
  const joinField = joinTable.fields.find((f) => f.name === joinFieldNm);
  const joinedTable = await Table.findOne({ name: joinField.reftable_name });
  const schema = db.getTenantSchema();
  const joinedRow = await joinedTable.getRow({ [valField]: value });
  await joinTable.insertRow({ [relField]: id, [joinFieldNm]: joinedRow.id });
  return { json: { success: "ok" } };
};

module.exports = {
  name: "EditBadges",
  display_state_form: false,
  get_state_fields,
  configuration_workflow,
  run,
  routes: { remove, add },
};
