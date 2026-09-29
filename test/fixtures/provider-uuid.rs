// Run as an example in datafusion-ducklake-provider at
// 6b97e804e50c4765964e0362dc5e665e1c630f72. See guides/uuid-cast-regression.md.
use ducklake_catalog::{ColumnId, SnapshotId};
use ducklake_storage::{
    CatalogBackend, CreateTableColumn, CreateTableCommit, DuckLakeCatalogInitOptions,
    quack::QuackCatalog,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let state: serde_json::Value = serde_json::from_slice(&std::fs::read(
        std::env::args().nth(1).expect("local catalog JSON path"),
    )?)?;
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async {
            let connect = || {
                QuackCatalog::try_new_with_ssl(
                    state["uri"].as_str().unwrap(),
                    state["jwt"].as_str().unwrap(),
                    false,
                )
            };
            let catalog = connect()?;
            catalog.connect().await?;
            catalog
                .initialize_ducklake(DuckLakeCatalogInitOptions {
                    data_path: Some(state["dataPath"].as_str().unwrap().into()),
                    ..Default::default()
                })
                .await?;
            let snapshot = catalog
                .commit_create_table(CreateTableCommit {
                    schema_name: "main".into(),
                    table_name: "uuid_regression".into(),
                    columns: vec![CreateTableColumn {
                        column_id: ColumnId(1),
                        column_order: 1,
                        column_name: "id".into(),
                        column_type: "int32".into(),
                        nulls_allowed: false,
                        parent_column: None,
                    }],
                    commit_message: "UUID CAST regression".into(),
                })
                .await?;
            assert_eq!(snapshot, SnapshotId(1));
            println!("PASS initialize, create table, snapshot 1");
            let schemas = catalog.schemas_at(snapshot).await?;
            let tables = catalog.tables_at(schemas[0].schema_id, snapshot).await?;
            assert_eq!(tables.len(), 1);
            assert!(uuid::Uuid::parse_str(&tables[0].table_uuid).is_ok());
            catalog.disconnect().await?;

            let reconnected = connect()?;
            reconnected.connect().await?;
            reconnected
                .initialize_ducklake(DuckLakeCatalogInitOptions {
                    create_if_not_exists: false,
                    ..Default::default()
                })
                .await?;
            assert_eq!(
                reconnected
                    .tables_at(schemas[0].schema_id, snapshot)
                    .await?[0]
                    .table_uuid,
                tables[0].table_uuid
            );
            reconnected.disconnect().await?;
            println!("PASS table metadata UUID, reconnect and UUID read");
            Ok(())
        })
}
