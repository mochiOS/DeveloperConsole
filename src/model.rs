use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    pub name: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
pub struct AccountEnvelope {
    pub account: Account,
}

#[derive(Debug, Deserialize)]
pub struct SessionRow {
    pub id: String,
    pub account_id: String,
}

pub struct SessionIssue {
    pub token: String,
}
