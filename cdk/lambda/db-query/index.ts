import { connectDatabase } from "../connections";

export const handler = async (event: any) => {
    const query = event.query;
    const pool = await connectDatabase();
    const client = await pool.connect();
    const result = await client.query(query);

    client.release();
    return {
        statusCode: 200,
        body: JSON.stringify({
            rows: result.rows,
            rowCount: result.rowCount
        })
    };
};
