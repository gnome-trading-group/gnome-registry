import { connectDatabase } from "../connections";

export const handler = async (event: any) => {
    const query = event.query;
    const pool = await connectDatabase();
    const client = await pool.connect();
    let failure: Error | undefined;
    try {
        const result = await client.query(query);
        return {
            statusCode: 200,
            body: JSON.stringify({
                rows: result.rows,
                rowCount: result.rowCount
            })
        };
    } catch (e) {
        failure = e as Error;
        throw e;
    } finally {
        // Every connection goes back, or a container's pool empties after a few bad queries and every later call
        // times out waiting for one; a failed query's is closed rather than reused.
        client.release(failure);
    }
};
