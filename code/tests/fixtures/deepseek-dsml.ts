export const deepseekDsmlResponse = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read_file">
<｜｜DSML｜｜ parameter name="input" string="false">{"path": "code/package.json"}</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
<｜｜DSML｜｜ invoke name="read_file">
<｜｜DSML｜｜ parameter name="input" string="false">{"path": "code/figo-agent.config.json"}</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
<｜｜DSML｜｜ invoke name="list_files">
<｜｜DSML｜｜ parameter name="input" string="false">{"path": "code/src", "depth": 1}</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
<｜｜DSML｜｜ invoke name="list_files">
<｜｜DSML｜｜ parameter name="input" string="false">{"path": "docs", "depth": 2}</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;
